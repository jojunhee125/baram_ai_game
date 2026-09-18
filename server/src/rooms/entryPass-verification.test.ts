import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import {
  Direction,
  MONSTER_TICK_MS,
  PLAYER_ATTACK_DAMAGE,
  ServerMessage,
  type EquipmentSlot,
  type JoinOptions,
  type PortalDenied,
  type PortalEntered,
  type RoomState,
  type ItemGranted,
} from "@zep-test/shared";
import { InMemoryInventoryStore, type InventoryRow, type InventoryStore } from "../db/inventoryStore";
import { TablePortalIndex } from "../game/portals";
import { createGameServer } from "../server";
import type { CollisionMap, PortalDefinition, PortalIndex, RoomCreateOptions } from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";
import { MonsterKind, type MonsterSpawnDefinition, type MonsterType } from "./monsterDefinitions";

/**
 * Independent re-verification of Phase G (hunting-den entry ticket), adversarial rather than
 * confirmatory. Built on the same private-method-access harness as `passE-combat-verification.test.ts`
 * (bracket access to `handleAttack`/`handleMove`, a fake `RoomClient`), extended with a
 * `createPortalIndex` override so a gated portal can be exercised without the matchmaker.
 */

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface SentMessage {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null; ssoUserId: string | null };
  userData?: { lastMoveAt: number; lastAttackAt: number; hp: number; lastDamagedAt: number };
  sent: SentMessage[];
}

function fakeClient(sessionId: string, ssoUserId: string | null = null): FakeClient {
  const sent: SentMessage[] = [];
  return {
    sessionId,
    auth: { ssoNickname: null, ssoUserId },
    sent,
    send: (type: string, payload: unknown) => {
      sent.push({ type, payload });
    },
  } as FakeClient;
}

function sentOfType<T>(client: FakeClient, type: string): T[] {
  return client.sent.filter((message) => message.type === type).map((message) => message.payload as T);
}

function asRoomClient(client: FakeClient): RoomClient {
  return client as unknown as RoomClient;
}

const OPEN_CENTRE = { tileX: 78, tileY: 70 };
const DOOR_TILE = { tileX: OPEN_CENTRE.tileX + 5, tileY: OPEN_CENTRE.tileY };
const START_TILE = { tileX: DOOR_TILE.tileX - 1, tileY: DOOR_TILE.tileY };

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "verify-gate",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
};

const GATED_PORTAL: PortalDefinition = {
  id: "gate",
  from: { room: ROOM_OPTIONS.roomType, tiles: [DOOR_TILE] },
  to: { room: ROOM_OPTIONS.roomType, arrival: { tileX: START_TILE.tileX, tileY: START_TILE.tileY, spreadRadiusInTiles: 0 } },
  requiresItemKey: "entry-pass",
  deniedMessage: "verify-denied",
};

/** One-hit-kill squirrel, 100% entry-pass drop — everything else about the row is irrelevant here. */
const ONE_HIT_ENTRY_PASS_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      maxHp: PLAYER_ATTACK_DAMAGE,
      damage: 0,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 0,
      leashRadiusTiles: 0,
      respawnDelayMs: MONSTER_TICK_MS * 100_000,
      expReward: 1,
      loot: [{ itemKey: "entry-pass", chance: 1, quantity: 1 }],
    },
  ],
]);

/**
 * A room whose one gated portal is authored here rather than read from `PORTAL_DEFINITIONS`, and
 * whose `createPortalIndex` forces a room name regardless of `this.roomName` — this harness never
 * goes through the matchmaker, so `this.roomName` is `undefined` and the real override would build
 * an index that answers null to everything (`TablePortalIndex`'s own documented behaviour).
 */
class GatedRoom extends MetaverseRoom {
  fixtureSpawns: readonly MonsterSpawnDefinition[] = [];

  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return this.fixtureSpawns;
  }

  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return ONE_HIT_ENTRY_PASS_TYPES;
  }

  protected override createPortalIndex(map: CollisionMap): PortalIndex {
    return new TablePortalIndex(ROOM_OPTIONS.roomType, [GATED_PORTAL], map);
  }

  override setSimulationInterval(): void {
    // A live timer would mutate state mid-assertion; every test here drives combat by hand.
  }
}

async function createGatedRoom(
  spawns: readonly MonsterSpawnDefinition[],
  store?: InventoryStore,
): Promise<GatedRoom> {
  const room = new GatedRoom();
  room.fixtureSpawns = spawns;
  await room.onCreate({ ...ROOM_OPTIONS, inventoryStore: store });
  return room;
}

function spawnAt(id: string, at: { tileX: number; tileY: number }): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind: MonsterKind.Squirrel, at, wanderRadiusTiles: 0 };
}

function join(
  room: MetaverseRoom,
  sessionId: string,
  options?: Partial<JoinOptions>,
  ssoUserId: string | null = null,
): FakeClient {
  const client = fakeClient(sessionId, ssoUserId);
  room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
  return client;
}

function place(room: MetaverseRoom, sessionId: string, tile: { tileX: number; tileY: number }): void {
  const player = room.state.players.get(sessionId);
  assert.ok(player);
  player.tileX = tile.tileX;
  player.tileY = tile.tileY;
  room["proximityIndex"].move(sessionId, tile);
  room["refreshViewFor"](sessionId);
  room["refreshMonsterViewFor"](sessionId);
}

function face(room: MetaverseRoom, sessionId: string, dir: Direction): void {
  const player = room.state.players.get(sessionId);
  assert.ok(player);
  player.facing = dir;
}

function attack(room: MetaverseRoom, client: FakeClient, at?: number): void {
  if (at !== undefined && client.userData) {
    client.userData.lastAttackAt = at;
  }
  room["handleAttack"](asRoomClient(client));
}

/** Bypasses the move-rate throttle for a direct `handleMove` call, mirroring `attack`'s `at` param. */
function resetMoveCooldown(client: FakeClient): void {
  if (client.userData) {
    client.userData.lastMoveAt = 0;
  }
}

function move(room: MetaverseRoom, client: FakeClient, dir: Direction): void {
  resetMoveCooldown(client);
  room["handleMove"](asRoomClient(client), { dir });
}

/** Lets a fire-and-forget async continuation (awardLoot, hydratePossessionCache) settle. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

describe("VERIFY kill-and-immediately-walk-through vs the async grant", () => {
  it("BUG: denies the killer's own immediate walk-through when no microtask separates the kill from the step", async () => {
    // The monster sits on the door tile itself; `killMonster` removes it from `state.monsters`
    // before this function returns, so the step that follows lands on an empty, walkable tile.
    const store = new InMemoryInventoryStore();
    const room = await createGatedRoom([spawnAt("m", DOOR_TILE)], store);
    try {
      const walker = join(room, "walker", undefined, "sso-gate-1");
      place(room, "walker", START_TILE);
      face(room, "walker", Direction.Right);

      attack(room, walker, 0);
      assert.equal(room.state.monsters.has("m"), false, "precondition: one hit killed the monster");

      // The exact case under test: no `await` of any kind between the kill and the step, i.e.
      // the same synchronous turn — what a batched pair of client messages would look like on
      // the server. `awardLoot`'s grant (and the killer's own `ownedPossessionKeys.add`) sits
      // behind `await store.grantOnce(...)`, which has not had a chance to run yet.
      move(room, walker, Direction.Right);

      const denials = sentOfType<PortalDenied>(walker, ServerMessage.PortalDenied);
      const entries = sentOfType<PortalEntered>(walker, ServerMessage.PortalEntered);

      // Documented evidence either way. If this fails, the design's claim that "the killer's own
      // session cache is updated synchronously at grant time" does not match the implementation:
      // `awardLoot`'s `ownedPossessionKeys.add()` runs strictly after `await store.grantOnce()`,
      // so a step with no intervening microtask sees the pre-grant state and is wrongly denied.
      assert.deepEqual(
        { denials: denials.length, entries: entries.length },
        { denials: 0, entries: 1 },
        "the killer's own immediate walk-through was denied — the grant is not actually synchronous with the kill",
      );
    } finally {
      dispose(room);
    }
  });

  it("control: the same walk-through succeeds once the grant's microtask is allowed to run first", async () => {
    const store = new InMemoryInventoryStore();
    const room = await createGatedRoom([spawnAt("m", DOOR_TILE)], store);
    try {
      const walker = join(room, "walker", undefined, "sso-gate-2");
      place(room, "walker", START_TILE);
      face(room, "walker", Direction.Right);

      attack(room, walker, 0);
      await flush();
      assert.equal(
        (await store.list("sso-gate-2")).some((row) => row.itemKey === "entry-pass"),
        true,
        "precondition: the grant committed",
      );

      move(room, walker, Direction.Right);

      assert.deepEqual(sentOfType<PortalDenied>(walker, ServerMessage.PortalDenied), []);
      assert.equal(sentOfType<PortalEntered>(walker, ServerMessage.PortalEntered).length, 1);
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY hydration race: a pending list() must not corrupt state, and a second attempt after resolution succeeds", () => {
  it("denies while list() is in flight, then allows once it resolves — no crash, no stuck session", async () => {
    let releaseList: () => void = () => {};
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listCalls = 0;
    const store: InventoryStore = {
      async list(_ownerKey: string): Promise<readonly InventoryRow[]> {
        listCalls++;
        await listGate;
        return [{ itemKey: "entry-pass", quantity: 1, equipped: false }];
      },
      add: () => Promise.resolve(null),
      grantOnce: () => Promise.resolve(false),
      getEquippedSlots: () => Promise.resolve({}),
      equip: () => Promise.resolve(false),
      unequip: () => Promise.resolve(false),
      remove: () => Promise.resolve(null),
    };

    const room = await createGatedRoom([], store);
    try {
      const walker = join(room, "walker", undefined, "sso-hydrate-1");
      place(room, "walker", START_TILE);
      face(room, "walker", Direction.Right);
      assert.equal(listCalls, 1, "onJoin must fire the catch-up read exactly once, synchronously");

      // Attempt #1: the store's answer has not arrived yet.
      move(room, walker, Direction.Right);
      assert.equal(
        sentOfType<PortalDenied>(walker, ServerMessage.PortalDenied).length,
        1,
        "denied while hydration is still pending",
      );
      assert.equal(sentOfType<PortalEntered>(walker, ServerMessage.PortalEntered).length, 0);

      // Step off the trigger tile so the next accepted step can fire it again, then let the
      // deferred read resolve and settle before trying a second time.
      move(room, walker, Direction.Left);
      releaseList();
      await flush();

      move(room, walker, Direction.Right);

      assert.equal(
        sentOfType<PortalDenied>(walker, ServerMessage.PortalDenied).length,
        1,
        "still exactly the one denial from before hydration resolved",
      );
      assert.equal(
        sentOfType<PortalEntered>(walker, ServerMessage.PortalEntered).length,
        1,
        "the second attempt, after hydration resolved, succeeds",
      );
      assert.ok(room.state.players.get(walker.sessionId), "the session survived the whole sequence intact");
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY repeated kills after already owning the pass are silent no-ops", () => {
  it("grants once, then sends no further ItemGranted and stores no extra quantity on later kills", async () => {
    const secondMonsterTile = { tileX: DOOR_TILE.tileX, tileY: DOOR_TILE.tileY + 10 };
    const store = new InMemoryInventoryStore();
    const room = await createGatedRoom(
      [spawnAt("m1", DOOR_TILE), spawnAt("m2", secondMonsterTile)],
      store,
    );
    try {
      const walker = join(room, "walker", undefined, "sso-repeat-1");
      place(room, "walker", START_TILE);
      face(room, "walker", Direction.Right);

      attack(room, walker, 0);
      await flush();
      assert.deepEqual(await store.list("sso-repeat-1"), [
        { itemKey: "entry-pass", quantity: 1, equipped: false },
      ]);
      assert.equal(sentOfType<ItemGranted>(walker, ServerMessage.ItemGranted).length, 1);

      // Loot keeps rolling on every kill, by design — the second kill's roll still hits 100%.
      place(room, "walker", { tileX: secondMonsterTile.tileX - 1, tileY: secondMonsterTile.tileY });
      face(room, "walker", Direction.Right);
      attack(room, walker, 0);
      await flush();

      assert.deepEqual(
        await store.list("sso-repeat-1"),
        [{ itemKey: "entry-pass", quantity: 1, equipped: false }],
        "quantity must stay 1, never 2",
      );
      assert.equal(
        sentOfType<ItemGranted>(walker, ServerMessage.ItemGranted).length,
        1,
        "the second, already-owned grant must not send a second ItemGranted",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY grand-plaza pays zero cost for a gate it does not have", () => {
  const PORT = 2587;
  let testServer: ColyseusTestServer;

  before(async () => {
    // A store that only counts, so a call the room should never make is caught rather than
    // silently answering something plausible.
    const listCalls: string[] = [];
    const getEquippedSlotsCalls: string[] = [];
    const countingStore: InventoryStore = {
      list: (ownerKey: string) => {
        listCalls.push(ownerKey);
        return Promise.resolve([]);
      },
      add: () => Promise.resolve(null),
      grantOnce: () => Promise.resolve(false),
      getEquippedSlots: (ownerKey: string) => {
        getEquippedSlotsCalls.push(ownerKey);
        return Promise.resolve({});
      },
      equip: () => Promise.resolve(false),
      unequip: () => Promise.resolve(false),
      remove: () => Promise.resolve(null),
    };
    (globalThis as { __listCalls?: string[] }).__listCalls = listCalls;
    (globalThis as { __getEquippedSlotsCalls?: string[] }).__getEquippedSlotsCalls = getEquippedSlotsCalls;
    const gameServer = createGameServer(undefined, countingStore);
    await gameServer.listen(PORT);
    testServer = new ColyseusTestServer(gameServer);
  });

  after(async () => {
    await testServer.shutdown();
  });

  afterEach(async () => {
    await testServer.cleanup();
  });

  it("builds an empty gatedItemKeys and never calls the store on join", async () => {
    const room = (await testServer.createRoom<RoomState>("grand-plaza", {})) as Awaited<
      ReturnType<ColyseusTestServer["createRoom"]>
    > & { state: RoomState };
    const client = await testServer.connectTo(room, { nickname: "visitor", avatarSkin: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      (room as unknown as MetaverseRoom)["gatedItemKeys"].size,
      0,
      "grand-plaza must own no gated portal",
    );
    assert.equal(
      (room as unknown as MetaverseRoom)["hasMonsters"],
      false,
      "precondition: grand-plaza has no monsters either",
    );
    const listCalls = (globalThis as { __listCalls?: string[] }).__listCalls ?? [];
    assert.equal(listCalls.length, 0, "onJoin must not touch the store at all for this room");
    const getEquippedSlotsCalls =
      (globalThis as { __getEquippedSlotsCalls?: string[] }).__getEquippedSlotsCalls ?? [];
    assert.equal(
      getEquippedSlotsCalls.length,
      0,
      "the equipment cache (Phase F/V) must also stay gated on hasMonsters for this room",
    );
    assert.ok(room.state.players.get(client.sessionId), "the join itself still succeeded");
  });
});

describe("VERIFY concurrent same-key grants settle correctly regardless of resolution order", () => {
  /**
   * A `store.grantOnce` under direct test control: every call queues instead of resolving, so a
   * test can drive two overlapping `awardLoot` calls through both resolution orders by hand.
   */
  class ControlledGrantStore implements InventoryStore {
    private readonly waiters: Array<{
      resolve: (granted: boolean) => void;
      reject: (cause: unknown) => void;
    }> = [];

    list(): Promise<readonly InventoryRow[]> {
      return Promise.resolve([]);
    }

    add(): Promise<number | null> {
      return Promise.resolve(null);
    }

    grantOnce(): Promise<boolean> {
      return new Promise((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }

    getEquippedSlots(): Promise<Partial<Record<EquipmentSlot, string>>> {
      return Promise.resolve({});
    }

    equip(): Promise<boolean> {
      return Promise.resolve(false);
    }

    unequip(): Promise<boolean> {
      return Promise.resolve(false);
    }

    remove(): Promise<number | null> {
      return Promise.resolve(null);
    }

    /** Resolves the Nth `grantOnce` call in call order (0-indexed) — not in resolution order. */
    settle(callIndex: number, granted: boolean): void {
      this.waiters[callIndex]!.resolve(granted);
    }

    fail(callIndex: number, cause: unknown): void {
      this.waiters[callIndex]!.reject(cause);
    }
  }

  function sessionOf(room: MetaverseRoom, sessionId: string) {
    const session = room["clientsBySession"].get(sessionId)?.userData;
    assert.ok(session, `no session registered for ${sessionId}`);
    return session;
  }

  /** Lands two one-hit kills of entry-pass-dropping squirrels with no `await` in between. */
  function killTwice(room: MetaverseRoom, walker: FakeClient, secondTile: { tileX: number; tileY: number }): void {
    attack(room, walker, 0);
    place(room, "walker", { tileX: secondTile.tileX - 1, tileY: secondTile.tileY });
    face(room, "walker", Direction.Right);
    attack(room, walker, 0);
  }

  /** The three-way generalisation of `killTwice` — three overlapping kills, still no `await` between any of them. */
  function killThrice(
    room: MetaverseRoom,
    walker: FakeClient,
    tiles: readonly [
      { tileX: number; tileY: number },
      { tileX: number; tileY: number },
      { tileX: number; tileY: number },
    ],
  ): void {
    for (const tile of tiles) {
      place(room, "walker", { tileX: tile.tileX - 1, tileY: tile.tileY });
      face(room, "walker", Direction.Right);
      attack(room, walker, 0);
    }
  }

  it("a losing call that resolves after a winning sibling must not erase the confirmed credit", async () => {
    const secondMonsterTile = { tileX: DOOR_TILE.tileX, tileY: DOOR_TILE.tileY + 10 };
    const store = new ControlledGrantStore();
    const room = await createGatedRoom(
      [spawnAt("m1", DOOR_TILE), spawnAt("m2", secondMonsterTile)],
      store,
    );
    try {
      const walker = join(room, "walker", undefined, "sso-race-1");
      place(room, "walker", START_TILE);
      face(room, "walker", Direction.Right);

      // Two kills, back to back, with no `await` between them: both `awardLoot` calls run their
      // synchronous pre-pass and reach `await store.grantOnce(...)` before either settles — the
      // exact overlap a plain "was this already cached" snapshot cannot tell apart from a grant
      // some other, unrelated call has already confirmed.
      killTwice(room, walker, secondMonsterTile);

      const session = sessionOf(room, "walker");
      assert.equal(session.ownedPossessionKeys.has("entry-pass"), true, "optimistic credit applied");
      assert.equal(session.pendingPossessionGrants.get("entry-pass"), 2, "both calls still in flight");

      // Resolve out of order: the *second* kill's database round trip wins the unique-row race
      // and confirms the grant; the *first* kill's call reports back afterwards, having lost it.
      store.settle(1, true);
      await flush();
      assert.equal(session.confirmedPossessionKeys.has("entry-pass"), true);

      store.settle(0, false);
      await flush();

      assert.equal(
        session.ownedPossessionKeys.has("entry-pass"),
        true,
        "a confirmed grant must survive a losing sibling resolving later",
      );
      assert.equal(session.pendingPossessionGrants.has("entry-pass"), false);
    } finally {
      dispose(room);
    }
  });

  it("two overlapping kills that both fail to grant must not leave a phantom permanent credit", async () => {
    const secondMonsterTile = { tileX: DOOR_TILE.tileX, tileY: DOOR_TILE.tileY + 10 };
    const store = new ControlledGrantStore();
    const room = await createGatedRoom(
      [spawnAt("m1", DOOR_TILE), spawnAt("m2", secondMonsterTile)],
      store,
    );
    try {
      const walker = join(room, "walker", undefined, "sso-race-2");
      place(room, "walker", START_TILE);
      face(room, "walker", Direction.Right);

      killTwice(room, walker, secondMonsterTile);

      const session = sessionOf(room, "walker");
      assert.equal(session.ownedPossessionKeys.has("entry-pass"), true, "optimistic credit applied");

      // Both round trips fail — e.g. a transient store error hitting both in-flight requests.
      // Neither ever confirms the grant, so nothing must be left claiming the account holds it.
      store.fail(1, new Error("transient store failure"));
      await flush();
      // The critical intermediate state: one sibling has reported in and failed, but the other
      // is still genuinely in flight and could yet succeed. Evicting here — before the second
      // attempt has had its say — would be its own bug, independent of the final answer below.
      assert.equal(
        session.ownedPossessionKeys.has("entry-pass"),
        true,
        "must not evict while a sibling attempt is still pending, even though this one just failed",
      );
      assert.equal(session.pendingPossessionGrants.get("entry-pass"), 1, "one attempt still outstanding");

      store.fail(0, new Error("transient store failure"));
      await flush();

      assert.equal(
        session.ownedPossessionKeys.has("entry-pass"),
        false,
        "neither call ever confirmed the grant — the cache must not claim the account holds it",
      );
      assert.equal(session.confirmedPossessionKeys.has("entry-pass"), false);
      assert.equal(session.pendingPossessionGrants.has("entry-pass"), false);
    } finally {
      dispose(room);
    }
  });

  it("three overlapping kills: the winner can settle first, in the middle, or last — confirmation always survives", async () => {
    const tiles: [{ tileX: number; tileY: number }, { tileX: number; tileY: number }, { tileX: number; tileY: number }] = [
      DOOR_TILE,
      { tileX: DOOR_TILE.tileX, tileY: DOOR_TILE.tileY + 10 },
      { tileX: DOOR_TILE.tileX, tileY: DOOR_TILE.tileY + 20 },
    ];
    // Which of the three call-order indices (0, 1, 2) is the one that actually wins the store's
    // unique-row race, for each of the three positions it can occupy in *resolution* order.
    const scenarios: ReadonlyArray<{ label: string; order: readonly [number, number, number]; winner: number }> = [
      { label: "winner resolves first", order: [1, 0, 2], winner: 1 },
      { label: "winner resolves in the middle", order: [0, 1, 2], winner: 1 },
      { label: "winner resolves last", order: [0, 2, 1], winner: 1 },
    ];

    for (const scenario of scenarios) {
      const store = new ControlledGrantStore();
      const room = await createGatedRoom(
        [spawnAt("m1", tiles[0]), spawnAt("m2", tiles[1]), spawnAt("m3", tiles[2])],
        store,
      );
      try {
        const walker = join(room, "walker", undefined, `sso-race-3-${scenario.label}`);
        killThrice(room, walker, tiles);

        const session = sessionOf(room, "walker");
        assert.equal(session.pendingPossessionGrants.get("entry-pass"), 3, `${scenario.label}: all three in flight`);

        for (const callIndex of scenario.order) {
          store.settle(callIndex, callIndex === scenario.winner);
          await flush();
        }

        assert.equal(
          session.ownedPossessionKeys.has("entry-pass"),
          true,
          `${scenario.label}: the confirmed grant must survive however the other two losers resolve`,
        );
        assert.equal(session.confirmedPossessionKeys.has("entry-pass"), true, scenario.label);
        assert.equal(session.pendingPossessionGrants.has("entry-pass"), false, scenario.label);
      } finally {
        dispose(room);
      }
    }
  });

  it("three overlapping kills that all fail: eviction waits for every attempt, never fires while one is still in flight", async () => {
    const tiles: [{ tileX: number; tileY: number }, { tileX: number; tileY: number }, { tileX: number; tileY: number }] = [
      DOOR_TILE,
      { tileX: DOOR_TILE.tileX, tileY: DOOR_TILE.tileY + 10 },
      { tileX: DOOR_TILE.tileX, tileY: DOOR_TILE.tileY + 20 },
    ];
    const store = new ControlledGrantStore();
    const room = await createGatedRoom(
      [spawnAt("m1", tiles[0]), spawnAt("m2", tiles[1]), spawnAt("m3", tiles[2])],
      store,
    );
    try {
      const walker = join(room, "walker", undefined, "sso-race-3-all-fail");
      killThrice(room, walker, tiles);

      const session = sessionOf(room, "walker");
      assert.equal(session.pendingPossessionGrants.get("entry-pass"), 3);

      store.fail(2, new Error("transient store failure"));
      await flush();
      assert.equal(session.ownedPossessionKeys.has("entry-pass"), true, "2 of 3 still outstanding");
      assert.equal(session.pendingPossessionGrants.get("entry-pass"), 2);

      store.fail(0, new Error("transient store failure"));
      await flush();
      assert.equal(session.ownedPossessionKeys.has("entry-pass"), true, "1 of 3 still outstanding");
      assert.equal(session.pendingPossessionGrants.get("entry-pass"), 1);

      store.settle(1, false);
      await flush();

      assert.equal(
        session.ownedPossessionKeys.has("entry-pass"),
        false,
        "all three reported in and none confirmed — the credit must be gone",
      );
      assert.equal(session.confirmedPossessionKeys.has("entry-pass"), false);
      assert.equal(session.pendingPossessionGrants.has("entry-pass"), false);
    } finally {
      dispose(room);
    }
  });
});
