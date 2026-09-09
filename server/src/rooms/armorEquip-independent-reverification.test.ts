import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Pool } from "pg";
import { ColyseusTestServer } from "@colyseus/testing";
import {
  Direction,
  PLAYER_ATTACK_DAMAGE,
  ServerMessage,
  type EquipmentChanged,
  type EquipmentSlot,
  type ItemGranted,
  type JoinOptions,
  type RoomState,
  type TilePosition,
} from "@zep-test/shared";
import {
  InMemoryInventoryStore,
  PostgresInventoryStore,
  type InventoryRow,
  type InventoryStore,
} from "../db/inventoryStore";
import { getDatabaseStatus, resetDatabaseStatus } from "../db/status";
import { createGameServer } from "../server";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import type { RoomCreateOptions } from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";
import { MonsterKind, type MonsterSpawnDefinition, type MonsterType } from "./monsterDefinitions";

/**
 * A second, independently written re-verification of the Phase F guardian patch (Bug1-4), built
 * from scratch rather than by trusting `armorEquip-verification.test.ts`'s own updated assertions
 * — that file is the guardian's own proof of its own patch and is not treated as evidence here.
 * Every test below targets a scenario that file does not cover, or covers only in a shape too
 * weak to have caught a wrong fix.
 */

const VALID_OWNER = "1f0d1a9c-6b7e-4f2a-9c31-0c4c2a5b8e10";

function stubPool(respond: (sql: string, values: readonly unknown[]) => { rows: Record<string, unknown>[] }): Pool {
  return {
    query(sql: string, values: readonly unknown[]) {
      try {
        return Promise.resolve(respond(sql, values));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  } as unknown as Pool;
}

describe("INDEPENDENT — Bug1: PostgresInventoryStore.equip() error discrimination", () => {
  beforeEach(resetDatabaseStatus);

  it("rethrows and marks the database degraded for a non-23505 failure, rather than swallowing every error", async () => {
    const pool = stubPool(() => {
      throw Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" });
    });
    const store = new PostgresInventoryStore(pool);
    await assert.rejects(() => store.equip(VALID_OWNER, "leather-armor", "armor"), /connection terminated/);
    assert.equal(getDatabaseStatus(), "degraded", "a real fault must still surface as degraded");
  });

  it("rethrows a foreign-key violation (23503) rather than mistaking it for the equip race's own 23505", async () => {
    const pool = stubPool(() => {
      throw Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
    });
    const store = new PostgresInventoryStore(pool);
    await assert.rejects(() => store.equip(VALID_OWNER, "leather-armor", "armor"), /foreign key/);
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("rethrows a non-Error rejection (e.g. a raw string) rather than crashing isUniqueViolation's shape check", async () => {
    const pool = stubPool(() => {
      throw "socket hang up";
    });
    const store = new PostgresInventoryStore(pool);
    await assert.rejects(() => store.equip(VALID_OWNER, "leather-armor", "armor"));
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("rethrows a thrown null without crashing (isUniqueViolation must reject typeof null === 'object' safely)", async () => {
    const pool = stubPool(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw null;
    });
    const store = new PostgresInventoryStore(pool);
    await assert.rejects(() => store.equip(VALID_OWNER, "leather-armor", "armor"));
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("swallows exactly a 23505 unique_violation, resolving false and marking the database ok, not degraded", async () => {
    const pool = stubPool(() => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    });
    const store = new PostgresInventoryStore(pool);
    const applied = await store.equip(VALID_OWNER, "leather-armor", "armor");
    assert.equal(applied, false);
    assert.equal(getDatabaseStatus(), "ok", "a losing race is not a database fault");
  });

  it("marks the database ok on a genuine success too, despite bypassing the shared query() helper", async () => {
    const pool = stubPool(() => ({ rows: [{ item_key: "leather-armor" }] }));
    const store = new PostgresInventoryStore(pool);
    const applied = await store.equip(VALID_OWNER, "leather-armor", "armor");
    assert.equal(applied, true);
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("unequip() is NOT given the same 23505 amnesty as equip() — it still routes through query() and degrades on any failure", async () => {
    // Proves the bypass in equip() is scoped to the one method that actually races a unique
    // index; every sibling method keeps the old, stricter behaviour.
    const pool = stubPool(() => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    });
    const store = new PostgresInventoryStore(pool);
    await assert.rejects(() => store.unequip(VALID_OWNER, "armor"));
    assert.equal(
      getDatabaseStatus(),
      "degraded",
      "unequip() has no unique index to race against, so a 23505 here would be a genuine anomaly, not a race",
    );
  });
});

describe("INDEPENDENT — Bug2: InventoryStore.unequip() returns a real boolean, not void", () => {
  it("InMemoryInventoryStore.unequip answers true for the call that actually clears an equip, false after", async () => {
    const store = new InMemoryInventoryStore();
    await store.add(VALID_OWNER, "leather-armor", 1);
    assert.equal(await store.equip(VALID_OWNER, "leather-armor", "armor"), true, "precondition: equip succeeded");

    assert.equal(await store.unequip(VALID_OWNER, "armor"), true, "the first unequip really did clear something");
    assert.equal(await store.unequip(VALID_OWNER, "armor"), false, "nothing was left to clear the second time");
  });

  it("InMemoryInventoryStore.unequip answers false for an owner who was never equipped at all", async () => {
    const store = new InMemoryInventoryStore();
    assert.equal(await store.unequip(randomUUID(), "armor"), false);
  });
});

/**
 * Bug3's real claim is not "hydration bumps the version when it should" in isolation — the
 * guardian's own test already covers that in isolation. The claim worth independently proving is
 * the *consequence*: an unconditional bump would have let a same-answer hydration silently
 * swallow a legitimate, concurrently in-flight equip/unequip response by making its version
 * compare fail for a reason that has nothing to do with a real conflicting write.
 *
 * Reproduced end to end through the private methods `handleEquipItem`/`handleUnequipItem` call
 * into, exactly the shape a real client causes: send a request, then let the join-time hydration
 * resolve first with an *answer that matches the cache already has* (the common case — nothing
 * happened between join and the catch-up read), then let the request's own store call resolve.
 */
describe("INDEPENDENT — Bug3 consequence: a same-answer hydration must never cause a concurrently in-flight equip/unequip response to be dropped", () => {
  interface FakeSession {
    equippedItemKeys: Partial<Record<EquipmentSlot, string>>;
    equipCacheVersions: Record<EquipmentSlot, number>;
    equipRequestPendingSlots: Set<EquipmentSlot>;
    lastMoveAt: number;
    lastAttackAt: number;
    hp: number;
    lastDamagedAt: number;
  }

  interface SentMessage {
    type: string;
    payload: unknown;
  }

  interface FakeClient {
    sessionId: string;
    auth: { ssoNickname: string | null; ssoUserId: string | null };
    userData?: FakeSession;
    sent: SentMessage[];
    send: (type: string, payload: unknown) => void;
  }

  type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

  function fakeClient(sessionId: string, ssoUserId: string): FakeClient {
    const sent: SentMessage[] = [];
    return {
      sessionId,
      auth: { ssoNickname: null, ssoUserId },
      sent,
      send: (type: string, payload: unknown) => {
        sent.push({ type, payload });
      },
    };
  }

  function asRoomClient(client: FakeClient): RoomClient {
    return client as unknown as RoomClient;
  }

  function sentOfType<T>(client: FakeClient, type: string): T[] {
    return client.sent.filter((message) => message.type === type).map((message) => message.payload as T);
  }

  /** Controls exactly two calls: the join-time `getEquippedSlots` and one `equip`/`unequip` call. */
  class ControlledStore implements InventoryStore {
    private getEquippedSlotsResolve: ((value: Partial<Record<EquipmentSlot, string>>) => void) | undefined;
    private equipResolve: ((value: boolean) => void) | undefined;
    private unequipResolve: ((value: boolean) => void) | undefined;

    list(): Promise<readonly InventoryRow[]> {
      return Promise.resolve([]);
    }
    add(): Promise<number | null> {
      return Promise.resolve(null);
    }
    grantOnce(): Promise<boolean> {
      return Promise.resolve(false);
    }
    getEquippedSlots(): Promise<Partial<Record<EquipmentSlot, string>>> {
      return new Promise((resolve) => {
        this.getEquippedSlotsResolve = resolve;
      });
    }
    equip(): Promise<boolean> {
      return new Promise((resolve) => {
        this.equipResolve = resolve;
      });
    }
    unequip(): Promise<boolean> {
      return new Promise((resolve) => {
        this.unequipResolve = resolve;
      });
    }
    /** Every test in this suite equips only the armor slot, so `null` means "no slots equipped". */
    settleGetEquipped(value: string | null): void {
      assert.ok(this.getEquippedSlotsResolve, "getEquippedSlots was never called");
      this.getEquippedSlotsResolve(value === null ? {} : { armor: value });
    }
    settleEquip(value: boolean): void {
      assert.ok(this.equipResolve, "equip was never called");
      this.equipResolve(value);
    }
    settleUnequip(value: boolean): void {
      assert.ok(this.unequipResolve, "unequip was never called");
      this.unequipResolve(value);
    }
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 8; index++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const ROOM_OPTIONS: RoomCreateOptions = {
    roomType: "verify-bug3-independent",
    mapKey: "grand-plaza",
    maxClients: 10,
    spawn: { tileX: 78, tileY: 70, spreadRadiusInTiles: 0 },
  };

  const INERT_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
    [
      MonsterKind.Deer,
      {
        kind: MonsterKind.Deer,
        maxHp: 1,
        damage: 0,
        attackCooldownMs: 1000,
        wanderStepIntervalMs: 1000,
        chaseStepIntervalMs: 1000,
        aggroRadiusTiles: 0,
        leashRadiusTiles: 0,
        respawnDelayMs: 1_000_000,
        loot: [],
      },
    ],
  ]);

  const INERT_SPAWNS: readonly MonsterSpawnDefinition[] = [
    { id: "inert", room: ROOM_OPTIONS.roomType, kind: MonsterKind.Deer, at: { tileX: 0, tileY: 0 }, wanderRadiusTiles: 0 },
  ];

  /**
   * `hydrateEquipmentCache` (the thing under test here) only fires in a `hasMonsters` room since
   * the Phase F reviewer fix — grand-plaza-shaped rooms must not pay that join-time DB cost. This
   * room needs *some* monster to make `hasMonsters` true; it is far off-tile and fully inert
   * (0 aggro/leash radius, 0 damage) so it never interferes with the session-cache logic under test.
   */
  class HasMonstersRoom extends MetaverseRoom {
    protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
      return INERT_SPAWNS;
    }
    protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
      return INERT_TYPES;
    }
    override setSimulationInterval(): void {
      // No live timer — every test here drives the scenario by hand.
    }
  }

  async function createRoom(store: InventoryStore): Promise<MetaverseRoom> {
    const room = new HasMonstersRoom();
    await room.onCreate({ ...ROOM_OPTIONS, inventoryStore: store });
    return room;
  }

  function join(room: MetaverseRoom, sessionId: string, ssoUserId: string): FakeClient {
    const client = fakeClient(sessionId, ssoUserId);
    room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0 } as JoinOptions);
    return client;
  }

  it("an equip in flight since before a same-answer hydration resolved is applied and announced, not silently dropped", async () => {
    const store = new ControlledStore();
    const room = await createRoom(store);
    try {
      // onJoin fires hydrateEquipmentCache's getEquippedSlots call; the session cache starts empty.
      const client = join(room, "s1", "sso-bug3-a");

      // A client message arrives before the hydration answers — same session, ordinary timing.
      room["handleEquipItem"](asRoomClient(client), { itemKey: "leather-armor", slot: "armor" });

      // The hydration resolves first, with the answer that matches what the cache already holds
      // (empty): the single most common case, since most sessions equipped nothing last visit.
      store.settleGetEquipped(null);
      await flush();

      // Only afterwards does the equip's own store call resolve.
      store.settleEquip(true);
      await flush();

      assert.equal(
        client.userData?.equippedItemKeys.armor,
        "leather-armor",
        "the equip must still have been applied to the cache",
      );
      assert.deepEqual(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged),
        [{ slot: "armor", itemKey: "leather-armor", applied: true }],
        "an unconditional-bump hydration would have made this equip's own version check fail, " +
          "dropping the response entirely — the client would see nothing at all for a request " +
          "that actually succeeded",
      );
    } finally {
      room.setPatchRate(null);
    }
  });

  it("an unequip in flight since before a same-answer hydration resolved is applied and announced, not silently dropped", async () => {
    const store = new ControlledStore();
    const room = await createRoom(store);
    try {
      const client = join(room, "s1", "sso-bug3-b");

      room["handleUnequipItem"](asRoomClient(client), { slot: "armor" });

      store.settleGetEquipped(null);
      await flush();

      store.settleUnequip(true);
      await flush();

      assert.equal(client.userData?.equippedItemKeys.armor, undefined);
      assert.deepEqual(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged),
        [{ slot: "armor", itemKey: null, applied: true }],
        "same regression, on the unequip path that shares settleEquipRequest",
      );
    } finally {
      room.setPatchRate(null);
    }
  });

  it("control case: hydration answering something the cache does NOT already hold still bumps the version, so a truly stale in-flight response is correctly the one that loses", async () => {
    // Sanity check on the harness itself and on the fix's other half: the version compare must
    // still do its job when the hydration answer really does differ from the cache. Otherwise
    // the two tests above could be passing only because nothing ever invalidates anything.
    const store = new ControlledStore();
    const room = await createRoom(store);
    try {
      const client = join(room, "s1", "sso-bug3-c");

      room["handleEquipItem"](asRoomClient(client), { itemKey: "leather-armor", slot: "armor" });

      // This time the hydration's answer genuinely differs from the empty cache it started at —
      // a sibling tab equipped something in an earlier visit that this session never learned of.
      store.settleGetEquipped("old-dagger");
      await flush();

      // The equip's own call resolves after, but is now the stale one: hydration's changed
      // answer already bumped the version out from under it.
      store.settleEquip(true);
      await flush();

      assert.equal(
        client.userData?.equippedItemKeys.armor,
        "old-dagger",
        "the changed hydration answer must win here — this is real Bug3 protection, not a bypass",
      );
    } finally {
      room.setPatchRate(null);
    }
  });
});

/**
 * Bug4, proven over an actual socket rather than by inspecting the plain JS object a FakeClient's
 * `send` stub captured. `ItemGranted.damageReductionRatio` is optional and, for a non-equipment
 * item, the room builds the message with the key present and the value `undefined`
 * (`definition.equipment?.damageReductionRatio`) — this proves that undefined value survives (or
 * is safely dropped by) whatever the real Colyseus transport does to it, rather than turning into
 * `null`, `NaN`, or a value that silently makes `InventoryPanel.buildRow`'s equip-button gate
 * misfire for a plain resource drop.
 */
describe("INDEPENDENT — Bug4 over a real socket: ItemGranted.damageReductionRatio", () => {
  const PORT = 2591;
  const OPEN_CENTRE: TilePosition = { tileX: 78, tileY: 70 };
  const EQUIPMENT_MONSTER = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
  const PLAIN_MONSTER = { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY + 6 };

  const LEATHER_ARMOR_REDUCTION = ITEM_DEFINITIONS.find((item) => item.key === "leather-armor")?.equipment
    ?.stats.damageReduction;
  assert.equal(LEATHER_ARMOR_REDUCTION, 0.2, "precondition: this file's assertion assumes the catalogue's own ratio");

  const WIRE_FIXTURE_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
    [
      MonsterKind.Deer,
      {
        kind: MonsterKind.Deer,
        maxHp: PLAYER_ATTACK_DAMAGE,
        damage: 0,
        attackCooldownMs: 200,
        wanderStepIntervalMs: 200,
        chaseStepIntervalMs: 200,
        aggroRadiusTiles: 0,
        leashRadiusTiles: 0,
        respawnDelayMs: 1_000_000,
        loot: [{ itemKey: "leather-armor", chance: 1, quantity: 1 }],
      },
    ],
    [
      MonsterKind.Squirrel,
      {
        kind: MonsterKind.Squirrel,
        maxHp: PLAYER_ATTACK_DAMAGE,
        damage: 0,
        attackCooldownMs: 200,
        wanderStepIntervalMs: 200,
        chaseStepIntervalMs: 200,
        aggroRadiusTiles: 0,
        leashRadiusTiles: 0,
        respawnDelayMs: 1_000_000,
        loot: [{ itemKey: "acorn", chance: 1, quantity: 1 }],
      },
    ],
  ]);

  const WIRE_FIXTURE_SPAWNS: readonly MonsterSpawnDefinition[] = [
    { id: "wire-deer", room: "verify-wire-loot", kind: MonsterKind.Deer, at: EQUIPMENT_MONSTER, wanderRadiusTiles: 0 },
    {
      id: "wire-squirrel",
      room: "verify-wire-loot",
      kind: MonsterKind.Squirrel,
      at: PLAIN_MONSTER,
      wanderRadiusTiles: 0,
    },
  ];

  class WireVerifyRoom extends MetaverseRoom {
    protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
      return WIRE_FIXTURE_SPAWNS;
    }
    protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
      return WIRE_FIXTURE_TYPES;
    }
    override setSimulationInterval(): void {
      // Driven by hand via `tick`, exactly like the guardian's own harness — a live timer would
      // fire mid-assertion.
    }
  }

  let testServer: ColyseusTestServer;
  const store = new InMemoryInventoryStore();

  before(async () => {
    const gameServer = createGameServer(undefined, store);
    gameServer.define("verify-wire-loot", WireVerifyRoom, {
      roomType: "verify-wire-loot",
      mapKey: "grand-plaza",
      maxClients: 10,
      spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
      inventoryStore: store,
    } satisfies RoomCreateOptions);
    await gameServer.listen(PORT);
    testServer = new ColyseusTestServer(gameServer);
  });

  after(async () => {
    await testServer.shutdown();
  });

  afterEach(async () => {
    await testServer.cleanup();
  });

  interface ClientRoom {
    readonly sessionId: string;
    onMessage(type: string, callback: (payload: unknown) => void): unknown;
  }

  function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const poll = (): void => {
        if (predicate()) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  it("an equipment-item drop arrives over the real socket with its numeric damageReductionRatio intact", async () => {
    const room = (await testServer.createRoom<RoomState>("verify-wire-loot", {})) as Awaited<
      ReturnType<ColyseusTestServer["createRoom"]>
    > & { state: RoomState };
    const client = (await testServer.connectTo(room, {
      nickname: "hunter",
      avatarSkin: 0,
    })) as unknown as ClientRoom;
    await waitUntil(() => room.state.players.get(client.sessionId) !== undefined, "hunter to appear");

    const grants: ItemGranted[] = [];
    client.onMessage(ServerMessage.ItemGranted, (message: unknown) => {
      grants.push(message as ItemGranted);
    });

    const serverRoom = room as unknown as MetaverseRoom;
    const player = room.state.players.get(client.sessionId);
    assert.ok(player);
    player.tileX = OPEN_CENTRE.tileX;
    player.tileY = OPEN_CENTRE.tileY;
    player.facing = Direction.Right;
    serverRoom["proximityIndex"].move(client.sessionId, { tileX: player.tileX, tileY: player.tileY });
    serverRoom["refreshMonsterViewFor"](client.sessionId);

    const serverClient = serverRoom["clientsBySession"].get(client.sessionId);
    assert.ok(serverClient, "the real Colyseus Client must be reachable from the room's own session map");
    serverRoom["handleAttack"](serverClient);

    await waitUntil(() => grants.length > 0, "the leather-armor ItemGranted to arrive over the socket");

    assert.equal(grants[0]?.itemKey, "leather-armor");
    assert.equal(
      grants[0]?.damageReductionRatio,
      LEATHER_ARMOR_REDUCTION,
      "the numeric field must survive real transport encode/decode, not just a FakeClient's captured object",
    );
  });

  it("a plain resource drop's ItemGranted arrives over the real socket with no usable damageReductionRatio, never a corrupted 0/null/NaN", async () => {
    const room = (await testServer.createRoom<RoomState>("verify-wire-loot", {})) as Awaited<
      ReturnType<ColyseusTestServer["createRoom"]>
    > & { state: RoomState };
    const client = (await testServer.connectTo(room, {
      nickname: "gatherer",
      avatarSkin: 0,
    })) as unknown as ClientRoom;
    await waitUntil(() => room.state.players.get(client.sessionId) !== undefined, "gatherer to appear");

    const grants: ItemGranted[] = [];
    client.onMessage(ServerMessage.ItemGranted, (message: unknown) => {
      grants.push(message as ItemGranted);
    });

    const serverRoom = room as unknown as MetaverseRoom;
    const player = room.state.players.get(client.sessionId);
    assert.ok(player);
    player.tileX = PLAIN_MONSTER.tileX - 1;
    player.tileY = PLAIN_MONSTER.tileY;
    player.facing = Direction.Right;
    serverRoom["proximityIndex"].move(client.sessionId, { tileX: player.tileX, tileY: player.tileY });
    serverRoom["refreshMonsterViewFor"](client.sessionId);

    const serverClient = serverRoom["clientsBySession"].get(client.sessionId);
    assert.ok(serverClient);
    serverRoom["handleAttack"](serverClient);

    await waitUntil(() => grants.length > 0, "the acorn ItemGranted to arrive over the socket");

    assert.equal(grants[0]?.itemKey, "acorn");
    assert.equal(
      grants[0]?.damageReductionRatio,
      undefined,
      "a plain resource must never arrive with a defined damageReductionRatio — that would wrongly " +
        "make the bag window draw an equip button for it",
    );
    assert.notEqual(grants[0]?.damageReductionRatio, 0, "an encoder that turns undefined into 0 is a corruption, not an omission");
  });
});
