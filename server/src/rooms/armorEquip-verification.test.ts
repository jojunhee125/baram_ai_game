import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import { Pool } from "pg";
import { ColyseusTestServer } from "@colyseus/testing";
import {
  Direction,
  MONSTER_TICK_MS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_MAX_HP,
  ServerMessage,
  type EquipmentChanged,
  type EquipmentSlot,
  type ItemGranted,
  type JoinOptions,
  type PlayerHit,
  type RoomState,
  type TilePosition,
} from "@zep-test/shared";
import {
  InMemoryInventoryStore,
  PostgresInventoryStore,
  type InventoryRow,
  type InventoryStore,
} from "../db/inventoryStore";
import { runMigrations } from "../db/migrate";
import { resetDatabaseStatus } from "../db/status";
import { createGameServer } from "../server";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import type { CollisionMap, ProximityIndex, RoomCreateOptions } from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";
import { MonsterKind, type MonsterSpawnDefinition, type MonsterType } from "./monsterDefinitions";

/**
 * Independent re-verification of Phase F (leather-armor equip/unequip), adversarial rather than
 * confirmatory. Built on the same private-method-access harness as `passE-combat-verification.test.ts`
 * and `entryPass-verification.test.ts`.
 */

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface SentMessage {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null; ssoUserId: string | null };
  userData?: {
    lastMoveAt: number;
    lastAttackAt: number;
    hp: number;
    lastDamagedAt: number;
    equippedItemKeys: Partial<Record<EquipmentSlot, string>>;
    equipCacheVersions: Record<EquipmentSlot, number>;
    equipRequestPendingSlots: Set<EquipmentSlot>;
  };
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

const OPEN_CENTRE: TilePosition = { tileX: 78, tileY: 70 };

const LEATHER_ARMOR_REDUCTION = ITEM_DEFINITIONS.find((item) => item.key === "leather-armor")?.equipment
  ?.stats.damageReduction;
assert.equal(LEATHER_ARMOR_REDUCTION, 0.2, "precondition: this file's math assumes the catalogue's own ratio");

/** Squirrel(5 dmg, the real post-nerf value) / Rabbit(1 dmg, a boundary fixture) / Deer(one-hit-kill armor drop). */
const FIXTURE_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      maxHp: 100,
      damage: 5,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 6,
      leashRadiusTiles: 10,
      respawnDelayMs: MONSTER_TICK_MS * 5,
      expReward: 1,
      loot: [],
    },
  ],
  [
    // Damage 1 is the boundary Math.max(1, Math.floor(1 * 0.8)) = Math.max(1, 0) exercises directly.
    MonsterKind.Rabbit,
    {
      kind: MonsterKind.Rabbit,
      maxHp: 100,
      damage: 1,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 6,
      leashRadiusTiles: 10,
      respawnDelayMs: MONSTER_TICK_MS * 5,
      expReward: 1,
      loot: [],
    },
  ],
  [
    MonsterKind.Deer,
    {
      kind: MonsterKind.Deer,
      maxHp: PLAYER_ATTACK_DAMAGE,
      damage: 0,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 0,
      leashRadiusTiles: 0,
      respawnDelayMs: MONSTER_TICK_MS * 100_000,
      expReward: 1,
      loot: [{ itemKey: "leather-armor", chance: 1, quantity: 1 }],
    },
  ],
]);

class VerifyRoom extends MetaverseRoom {
  fixtureSpawns: readonly MonsterSpawnDefinition[] = [];

  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return this.fixtureSpawns;
  }

  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return FIXTURE_TYPES;
  }

  protected override createMonsterIndex(map: CollisionMap): ProximityIndex {
    return super.createMonsterIndex(map);
  }

  override setSimulationInterval(): void {
    // A live timer would mutate state mid-assertion; every test here drives `tick` itself.
  }
}

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "verify-armor",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
};

function spawnAt(id: string, kind: MonsterKind, at: TilePosition): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind, at, wanderRadiusTiles: 0 };
}

/**
 * The session-cache tests keep an inert monster so combat assertions can share the same room
 * fixture without background damage. Equipment appearance now hydrates in every room.
 */
const INERT_SPAWN = spawnAt("inert-hasMonsters-fixture", MonsterKind.Deer, { tileX: 0, tileY: 0 });

async function createRoom(
  spawns: readonly MonsterSpawnDefinition[],
  store?: InventoryStore,
): Promise<VerifyRoom> {
  const room = new VerifyRoom();
  room.fixtureSpawns = spawns;
  await room.onCreate({ ...ROOM_OPTIONS, inventoryStore: store });
  return room;
}

function join(
  room: MetaverseRoom,
  sessionId: string,
  ssoUserId: string | null = null,
  options?: Partial<JoinOptions>,
): FakeClient {
  const client = fakeClient(sessionId, ssoUserId);
  room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
  return client;
}

function place(room: MetaverseRoom, sessionId: string, tile: TilePosition): void {
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

/** Every test in this file equips into the armor slot only, so that is this helper's default. */
function equipItem(
  room: MetaverseRoom,
  client: FakeClient,
  itemKey: string,
  slot: EquipmentSlot = "armor",
): void {
  room["handleEquipItem"](asRoomClient(client), { itemKey, slot });
}

function unequipItem(room: MetaverseRoom, client: FakeClient, slot: EquipmentSlot = "armor"): void {
  room["handleUnequipItem"](asRoomClient(client), { slot });
}

/** Lets a fire-and-forget async continuation (settleEquipRequest, awardLoot, hydration) settle. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

/**
 * An `InventoryStore` whose `getEquippedSlots`/`equip`/`unequip` never resolve on their own — a
 * test drives each call's settlement by hand, in whichever order the scenario needs. `list`/`add`/
 * `grantOnce` are never exercised by the tests in this file and answer inertly. Every test here
 * only ever equips into the armor slot, so `settleGetEquipped` keeps its single-value shape from
 * Phase F and translates it to the one-slot map `getEquippedSlots` actually answers with.
 */
class ControlledEquipStore implements InventoryStore {
  private readonly getEquippedSlotsWaiters: Array<
    (value: Partial<Record<EquipmentSlot, string>>) => void
  > = [];
  private readonly equipWaiters: Array<{
    resolve: (value: boolean) => void;
    reject: (cause: unknown) => void;
  }> = [];
  private readonly unequipWaiters: Array<(value: boolean) => void> = [];

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
      this.getEquippedSlotsWaiters.push(resolve);
    });
  }

  equip(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.equipWaiters.push({ resolve, reject });
    });
  }

  unequip(): Promise<boolean> {
    return new Promise((resolve) => {
      this.unequipWaiters.push(resolve);
    });
  }

  remove(): Promise<number | null> {
    return Promise.resolve(null);
  }

  settleGetEquipped(callIndex: number, value: string | null): void {
    this.getEquippedSlotsWaiters[callIndex]!(value === null ? {} : { armor: value });
  }

  settleEquip(callIndex: number, value: boolean): void {
    this.equipWaiters[callIndex]!.resolve(value);
  }

  failEquip(callIndex: number, cause: unknown): void {
    this.equipWaiters[callIndex]!.reject(cause);
  }

  settleUnequip(callIndex: number, value = true): void {
    this.unequipWaiters[callIndex]!(value);
  }

  get getEquippedCallCount(): number {
    return this.getEquippedSlotsWaiters.length;
  }

  get equipCallCount(): number {
    return this.equipWaiters.length;
  }

  get unequipCallCount(): number {
    return this.unequipWaiters.length;
  }
}

describe("VERIFY equipCacheVersions[slot] protects a settled equip/unequip against a stale hydration", () => {
  it("an equip that settles before a slower join-time hydration is not clobbered by the hydration's stale answer", async () => {
    const store = new ControlledEquipStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-hydrate-race-1");
      assert.equal(store.getEquippedCallCount, 1, "onJoin must fire the catch-up read exactly once");

      equipItem(room, client, "leather-armor");
      assert.equal(store.equipCallCount, 1);

      store.settleEquip(0, true);
      await flush();
      assert.equal(client.userData?.equippedItemKeys.armor, "leather-armor", "the equip applied");
      const versionAfterEquip = client.userData?.equipCacheVersions.armor;

      // The stale hydration, which started before the equip and answers only now, must lose.
      store.settleGetEquipped(0, null);
      await flush();

      assert.equal(
        client.userData?.equippedItemKeys.armor,
        "leather-armor",
        "a stale hydration must not overwrite the equip that already landed",
      );
      assert.equal(
        client.userData?.equipCacheVersions.armor,
        versionAfterEquip,
        "a discarded hydration must not itself bump the version",
      );
      assert.deepEqual(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged),
        [{ slot: "armor", itemKey: "leather-armor", applied: true }],
        "the hydration losing the race sends nothing at all — only the equip's own verdict",
      );
    } finally {
      dispose(room);
    }
  });

  it("FIXED: hydrateEquipmentCache bumps equipCacheVersions[slot] when its answer actually changes the cache, matching the field's own doc comment", async () => {
    // contracts.ts's PlayerSession.equipCacheVersions doc: "Bumped by every write that actually
    // changes the cache (hydration, a confirmed equip, a confirmed unequip)". Was previously
    // false for hydration — metaverseRoom.ts hydrateEquipmentCache wrote
    // `current.equippedItemKey = equipped;` and never touched the version. No corruption
    // was observed from that only because exactly one hydration ever runs per session and
    // equip/unequip is serialized by `equipRequestPendingSlots` — a future caller that assumed the
    // documented contract held would not have been so lucky.
    const store = new ControlledEquipStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-doc-mismatch-1");
      const versionBeforeHydration = client.userData?.equipCacheVersions.armor;
      assert.equal(versionBeforeHydration, 0);

      store.settleGetEquipped(0, "some-earlier-visit-item");
      await flush();

      assert.equal(
        client.userData?.equippedItemKeys.armor,
        "some-earlier-visit-item",
        "hydration applied its answer",
      );
      assert.equal(
        client.userData?.equipCacheVersions.armor,
        (versionBeforeHydration ?? 0) + 1,
        "a cache-changing hydration now bumps the version exactly once, matching the doc comment",
      );
    } finally {
      dispose(room);
    }
  });

  it("hydrateEquipmentCache does not bump equipCacheVersions[slot] when its answer leaves the cache unchanged", async () => {
    // The common case: nothing has happened between join and the catch-up read resolving, so the
    // read confirms the initial absence rather than changing it. A bump here would have no
    // upside and a real downside — it would invalidate a same-session equip/unequip request still
    // in flight (captured `versionAtStart` before this hydration started) for no reason at all.
    const store = new ControlledEquipStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-doc-mismatch-2");
      const versionBeforeHydration = client.userData?.equipCacheVersions.armor;

      store.settleGetEquipped(0, null);
      await flush();

      assert.equal(client.userData?.equippedItemKeys.armor, undefined);
      assert.equal(
        client.userData?.equipCacheVersions.armor,
        versionBeforeHydration,
        "an unchanged answer must not bump the version",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY equipRequestPendingSlots serializes one session's own requests, per slot", () => {
  it("a second request on the same session and slot while the first is still in flight is dropped, not queued, and never reaches the store", async () => {
    const store = new ControlledEquipStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-pending-1");
      store.settleGetEquipped(0, null);
      await flush();

      equipItem(room, client, "leather-armor");
      assert.equal(
        client.userData?.equipRequestPendingSlots.has("armor"),
        true,
        "precondition: the first request is in flight",
      );

      // The overlapping request, sent before the first one's store call has resolved.
      unequipItem(room, client);
      assert.equal(store.unequipCallCount, 0, "the overlapping unequip must never reach the store at all");

      store.settleEquip(0, true);
      await flush();

      assert.equal(
        client.userData?.equippedItemKeys.armor,
        "leather-armor",
        "only the first request's result survives",
      );
      assert.equal(client.userData?.equipRequestPendingSlots.has("armor"), false);
      assert.deepEqual(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged),
        [{ slot: "armor", itemKey: "leather-armor", applied: true }],
        "exactly one verdict is sent for the two messages the client sent",
      );
    } finally {
      dispose(room);
    }
  });

  it("once the first request settles, a session's next request on the same slot is accepted normally", async () => {
    const store = new ControlledEquipStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-pending-2");
      store.settleGetEquipped(0, null);
      await flush();

      equipItem(room, client, "leather-armor");
      store.settleEquip(0, true);
      await flush();
      assert.equal(client.userData?.equipRequestPendingSlots.has("armor"), false);

      unequipItem(room, client);
      assert.equal(store.unequipCallCount, 1, "the request after the first one settled must reach the store");
      store.settleUnequip(0);
      await flush();

      assert.equal(client.userData?.equippedItemKeys.armor, undefined);
      assert.deepEqual(sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged), [
        { slot: "armor", itemKey: "leather-armor", applied: true },
        { slot: "armor", itemKey: null, applied: true },
      ]);
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY an equip/unequip that resolves after the session has left is a silent no-op, not a crash", () => {
  it("an equip resolving after onLeave touches nothing and sends nothing", async () => {
    const store = new ControlledEquipStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-leave-1");
      store.settleGetEquipped(0, null);
      await flush();

      equipItem(room, client, "leather-armor");
      assert.equal(store.equipCallCount, 1);

      room.onLeave(asRoomClient(client));
      assert.equal(room["clientsBySession"].has("s1"), false, "precondition: the session is gone");

      assert.doesNotThrow(() => store.settleEquip(0, true));
      await flush();

      assert.equal(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged).length,
        0,
        "a departed session must never receive a verdict",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("FIXED: EquipmentChanged.applied for an unequip is derived from what the store actually did, not from the session's stale local cache", () => {
  it("a session synchronizes a sibling's equip and reports applied:true when its unequip clears the store", async () => {
    const store = new InMemoryInventoryStore();
    const ownerKey = "shared-owner";

    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", ownerKey);
      await flush();
      assert.equal(
        client.userData?.equippedItemKeys.armor,
        undefined,
        "precondition: hydration caught up to an empty bag",
      );

      // The sibling tab's action now synchronizes the active session through the shared store.
      await store.grantOnce(ownerKey, "leather-armor");
      await store.equip(ownerKey, "leather-armor", "armor");
      assert.deepEqual(
        await store.getEquippedSlots(ownerKey),
        { armor: "leather-armor" },
        "precondition: the sibling really equipped it",
      );
      assert.equal(
        client.userData?.equippedItemKeys.armor,
        "leather-armor",
        "the equipment subscription refreshes this session after a sibling's equip",
      );
      client.sent.length = 0;

      unequipItem(room, client);
      await flush();

      assert.deepEqual(
        await store.getEquippedSlots(ownerKey),
        {},
        "the store call this triggered really did clear the account's equipped row",
      );
      assert.deepEqual(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged),
        [{ slot: "armor", itemKey: null, applied: true }],
        "the client is now told applied:true, derived from InventoryStore.unequip's own return " +
          "value rather than the session's stale pre-call cache — the real state change reaches " +
          "the open bag UI instead of being dropped by InventoryPanel.applyEquipmentChange",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY damage reduction — the equipped 20% reduction applies to the number sent to the client, not the raw monster stat", () => {
  it("floors the reduced damage, and reverts to the raw value the hit after unequip", async () => {
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", MonsterKind.Squirrel, OPEN_CENTRE)], store);
    try {
      const victim = join(room, "victim", "sso-dmg-1");
      place(room, "victim", OPEN_CENTRE);
      await store.grantOnce("sso-dmg-1", "leather-armor");
      equipItem(room, victim, "leather-armor");
      await flush();
      assert.equal(victim.userData?.equippedItemKeys.armor, "leather-armor", "precondition: armor is on");

      room["tick"](1000);
      const firstHit = sentOfType<PlayerHit>(victim, ServerMessage.PlayerHit).at(-1);
      assert.equal(firstHit?.damage, Math.floor(5 * 0.8), "20% off 5 floors to 4");
      assert.equal(victim.userData?.hp, PLAYER_MAX_HP - 4);

      unequipItem(room, victim);
      await flush();
      assert.equal(victim.userData?.equippedItemKeys.armor, undefined);

      room["tick"](1000 + MONSTER_TICK_MS);
      const secondHit = sentOfType<PlayerHit>(victim, ServerMessage.PlayerHit).at(-1);
      assert.equal(secondHit?.damage, 5, "unequipped, the very next hit is back to the raw value");
      assert.equal(victim.userData?.hp, PLAYER_MAX_HP - 4 - 5);
    } finally {
      dispose(room);
    }
  });

  it("never reduces a hit to 0 — the floor is clamped at 1 even when 20% off would round down to nothing", async () => {
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", MonsterKind.Rabbit, OPEN_CENTRE)], store);
    try {
      const victim = join(room, "victim", "sso-dmg-2");
      place(room, "victim", OPEN_CENTRE);
      await store.grantOnce("sso-dmg-2", "leather-armor");
      equipItem(room, victim, "leather-armor");
      await flush();

      room["tick"](1000);
      const hit = sentOfType<PlayerHit>(victim, ServerMessage.PlayerHit).at(-1);
      assert.equal(Math.floor(1 * 0.8), 0, "precondition: an unclamped floor would be 0");
      assert.equal(hit?.damage, 1, "clamped to a minimum of 1 — an equipped player must stay killable");
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY a kill drop never auto-equips", () => {
  it("leather-armor lands in the bag unequipped even though the account owns nothing else", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", MonsterKind.Deer, faced)], store);
    try {
      const hunter = join(room, "hunter", "sso-drop-1");
      place(room, "hunter", OPEN_CENTRE);
      face(room, "hunter", Direction.Right);

      attack(room, hunter, 0);
      await flush();

      assert.deepEqual(await store.list("sso-drop-1"), [
        { itemKey: "leather-armor", quantity: 1, equipped: false },
      ]);
      assert.equal(
        hunter.userData?.equippedItemKeys.armor,
        undefined,
        "the session cache must not auto-populate either",
      );
      assert.equal(
        sentOfType<ItemGranted>(hunter, ServerMessage.ItemGranted).length,
        1,
        "one grant notice, and nothing that looks like an equip verdict",
      );
      assert.equal(sentOfType<EquipmentChanged>(hunter, ServerMessage.EquipmentChanged).length, 0);
    } finally {
      dispose(room);
    }
  });

  it("FIXED: awardLoot's ItemGranted carries damageReductionRatio for an equipment item, so the equip button renders without a bag close/reopen", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", MonsterKind.Deer, faced)], store);
    try {
      const hunter = join(room, "hunter", "sso-drop-2");
      place(room, "hunter", OPEN_CENTRE);
      face(room, "hunter", Direction.Right);

      attack(room, hunter, 0);
      await flush();

      const grant = sentOfType<ItemGranted>(hunter, ServerMessage.ItemGranted).at(0);
      assert.ok(grant);
      assert.equal(
        grant.damageReductionRatio,
        LEATHER_ARMOR_REDUCTION,
        "the field now travels on the live drop toast, matching what GET /api/inventory sends",
      );
    } finally {
      dispose(room);
    }
  });

  it("a bag already holding the possession item rejects a second grant and stays unequipped", async () => {
    const secondMonsterTile = { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY + 10 };
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const store = new InMemoryInventoryStore();
    const room = await createRoom(
      [spawnAt("m1", MonsterKind.Deer, faced), spawnAt("m2", MonsterKind.Deer, secondMonsterTile)],
      store,
    );
    try {
      const hunter = join(room, "hunter", "sso-drop-3");
      place(room, "hunter", OPEN_CENTRE);
      face(room, "hunter", Direction.Right);
      attack(room, hunter, 0);
      await flush();

      place(room, "hunter", { tileX: secondMonsterTile.tileX - 1, tileY: secondMonsterTile.tileY });
      face(room, "hunter", Direction.Right);
      attack(room, hunter, 0);
      await flush();

      assert.deepEqual(
        await store.list("sso-drop-3"),
        [{ itemKey: "leather-armor", quantity: 1, equipped: false }],
        "still exactly one row, still unequipped",
      );
      assert.equal(
        sentOfType<ItemGranted>(hunter, ServerMessage.ItemGranted).length,
        1,
        "the second, already-owned drop must not send a second grant",
      );
    } finally {
      dispose(room);
    }
  });
});

/**
 * The half of this feature no in-process stub can reach: whether two genuinely concurrent
 * `MetaverseRoom.handleEquipItem` calls for the *same account* (two sessions — the ordinary
 * shape of the same SSO user open in two tabs) leave the database consistent, and what each
 * session is actually told. Opt-in for `inventoryStore.test.ts`'s own reason: no container, no
 * run. Point `ZEP_TEST_DATABASE_URL` at a scratch Postgres to exercise it — see that file's own
 * header comment for the exact `docker run` line.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

describe(
  "VERIFY cross-session (same account, two tabs) equip race against a real database",
  { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false },
  () => {
    let pool: Pool;

    before(async () => {
      pool = new Pool({ connectionString: REAL_DATABASE_URL, max: 8 });
      await runMigrations(pool);
      resetDatabaseStatus();
    });

    after(async () => {
      await pool.end();
      resetDatabaseStatus();
    });

    it(
      "queued same-account equips publish each committed state once to both sessions and converge on the database slot",
      async () => {
        // Exercise persistence and session synchronization through the existing fixture seam.
        // Catalog validation is covered separately; this second stack isolates slot contention.
        const store = new PostgresInventoryStore(pool);
        const ownerKey = randomUUID();
        await store.add(ownerKey, "leather-armor", 1);
        await store.add(ownerKey, "phantom-second-armor", 1);

        const room = await createRoom([INERT_SPAWN], store);
        try {
          // Two sessions, same SSO account — exactly what two browser tabs for one login produce.
          const tabA = join(room, "tabA", ownerKey);
          const tabB = join(room, "tabB", ownerKey);
          const outcomes: { itemKey: string; applied: boolean }[] = [];
          const runEquip = async (itemKey: string): Promise<boolean> => {
            const applied = await store.equip(ownerKey, itemKey, "armor");
            outcomes.push({ itemKey, applied });
            return applied;
          };

          // Awaited directly (not fire-and-forget + `flush()`, which this file's other tests use):
          // those races are between in-process promises with no real latency, so a handful of
          // `setImmediate` rounds always outlasts them. A genuine socket round trip to Postgres
          // does not respect that budget, so the only honest way to know both continuations —
          // including their trailing `client.send` — have actually finished is to await them.
          await Promise.all([
            room["settleEquipRequest"](
              asRoomClient(tabA),
              "armor",
              () => runEquip("leather-armor"),
              "leather-armor",
            ),
            room["settleEquipRequest"](
              asRoomClient(tabB),
              "armor",
              () => runEquip("phantom-second-armor"),
              "phantom-second-armor",
            ),
          ]);

          const rows = await store.list(ownerKey);
          const equippedRows = rows.filter((row) => row.equipped);
          assert.equal(equippedRows.length, 1, "the database must never end up with two equipped rows");

          const changedA = sentOfType<EquipmentChanged>(tabA, ServerMessage.EquipmentChanged);
          const changedB = sentOfType<EquipmentChanged>(tabB, ServerMessage.EquipmentChanged);

          assert.deepEqual(outcomes, [
            { itemKey: "leather-armor", applied: true },
            { itemKey: "phantom-second-armor", applied: false },
          ], "the conflicting store operation resolves false instead of throwing");
          const committed = outcomes.filter((outcome) => outcome.applied);
          const expectedChanges = committed.map(({ itemKey }) => ({ slot: "armor", itemKey, applied: true }));
          // These are account subscription updates, not private request verdicts. Even a tab
          // whose own write declines must receive the successful sibling's canonical state.
          assert.deepEqual(changedA, expectedChanges, "tabA receives each committed state exactly once");
          assert.deepEqual(changedB, expectedChanges, "tabB receives each committed state exactly once");
          const finalItem = committed.at(-1)!.itemKey;
          assert.equal(equippedRows[0]?.itemKey, finalItem);
          for (const tab of [tabA, tabB]) {
            assert.equal(tab.userData?.equippedItemKeys.armor, finalItem, "every session converges on the persisted equipment");
            assert.equal(tab.userData?.equipRequestPendingSlots.has("armor"), false, "every settled request clears its pending flag");
          }
        } finally {
          dispose(room);
        }
      },
    );
  },
);

/**
 * Public weapon and armor appearance requires one equipment catch-up read in grand-plaza too.
 * Possession hydration remains gated independently by the room's doors.
 */
describe("VERIFY grand-plaza hydrates equipment appearance once", () => {
  const PORT = 2589;
  let testServer: ColyseusTestServer;
  let getEquippedCalls: string[];

  before(async () => {
    getEquippedCalls = [];
    const countingStore: InventoryStore = {
      list: () => Promise.resolve([]),
      add: () => Promise.resolve(null),
      grantOnce: () => Promise.resolve(false),
      getEquippedSlots: (ownerKey: string) => {
        getEquippedCalls.push(ownerKey);
        return Promise.resolve({});
      },
      equip: () => Promise.resolve(false),
      unequip: () => Promise.resolve(false),
      remove: () => Promise.resolve(null),
    };
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

  it("calls getEquippedSlots once on a grand-plaza join for public equipment appearance", async () => {
    const room = (await testServer.createRoom<RoomState>("grand-plaza", {})) as Awaited<
      ReturnType<ColyseusTestServer["createRoom"]>
    > & { state: RoomState };
    const client = await testServer.connectTo(room, { nickname: "visitor", avatarSkin: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      (room as unknown as MetaverseRoom)["gatedItemKeys"].size,
      0,
      "precondition, matching entryPass-verification.test.ts: grand-plaza gates nothing",
    );
    assert.deepEqual(getEquippedCalls, [client.sessionId], "appearance hydration reads this visitor's equipment once");
    assert.ok(room.state.players.get(client.sessionId), "the join itself still succeeded");
  });
});
