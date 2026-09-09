import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
  MONSTER_TICK_MS,
  ServerMessage,
  type EquipmentChanged,
  type EquipmentSlot,
  type JoinOptions,
  type PlayerHit,
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
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import type { CollisionMap, ItemDefinition, ProximityIndex, RoomCreateOptions } from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";
import { MonsterKind, type MonsterSpawnDefinition, type MonsterType } from "./monsterDefinitions";

/**
 * Phase V Pass T2-T5 (`docs/design-phase-v-equipment-system.md` §9). Adversarial re-verification
 * of Pass S's 8-slot expansion, built on the same private-method-access harness as
 * `armorEquip-verification.test.ts` — that file's own coverage (same-slot races, single-slot
 * damage reduction) is not repeated here except where a test doubles as this Phase's regression
 * proof; every test below targets what only became possible once a session had more than one slot.
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

const OPEN_CENTRE: TilePosition = { tileX: 60, tileY: 60 };

const FIXTURE_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      maxHp: 100,
      // A round number, chosen so multiplicative-vs-additive combination of several damage
      // reduction ratios lands on two different, unambiguous integers (see the T5 describe block).
      damage: 100,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 6,
      leashRadiusTiles: 10,
      respawnDelayMs: MONSTER_TICK_MS * 5,
      loot: [],
    },
  ],
  [
    MonsterKind.Deer,
    {
      kind: MonsterKind.Deer,
      maxHp: 1_000_000,
      damage: 0,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 0,
      leashRadiusTiles: 0,
      respawnDelayMs: MONSTER_TICK_MS * 100_000,
      loot: [],
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
  roomType: "verify-equipment-slots",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
};

function spawnAt(id: string, kind: MonsterKind, at: TilePosition): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind, at, wanderRadiusTiles: 0 };
}

/** Same reasoning as `armorEquip-verification.test.ts`'s own `INERT_SPAWN`: purely to make `hasMonsters` true. */
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

function equipItem(room: MetaverseRoom, client: FakeClient, itemKey: string, slot: EquipmentSlot): void {
  room["handleEquipItem"](asRoomClient(client), { itemKey, slot });
}

function unequipItem(room: MetaverseRoom, client: FakeClient, slot: EquipmentSlot): void {
  room["handleUnequipItem"](asRoomClient(client), { slot });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

/**
 * An `InventoryStore` whose `equip`/`unequip` never resolve on their own, generalized (unlike
 * `armorEquip-verification.test.ts`'s own `ControlledEquipStore`) to any slot rather than only
 * `armor` — this Phase's whole point is that two different slots must never see each other, so the
 * harness has to be able to hold two *different* slots' calls open at once. `getEquippedSlots`
 * resolves immediately with whatever map it is constructed with, since the tests using this store
 * are about the equip/unequip verdict race, not about hydration timing (that is `armorEquip-
 * verification.test.ts`'s own territory, reused unchanged by `hasMonsters`-gate tests below).
 */
class MultiSlotControlledStore implements InventoryStore {
  private readonly equipWaiters: Array<{ resolve: (value: boolean) => void }> = [];
  private readonly unequipWaiters: Array<{ resolve: (value: boolean) => void }> = [];

  constructor(private readonly hydrationAnswer: Partial<Record<EquipmentSlot, string>> = {}) {}

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
    return Promise.resolve(this.hydrationAnswer);
  }
  equip(_ownerKey: string, _itemKey: string, _slot: EquipmentSlot): Promise<boolean> {
    return new Promise((resolve) => {
      this.equipWaiters.push({ resolve });
    });
  }
  unequip(_ownerKey: string, _slot: EquipmentSlot): Promise<boolean> {
    return new Promise((resolve) => {
      this.unequipWaiters.push({ resolve });
    });
  }

  settleEquip(callIndex: number, value: boolean): void {
    this.equipWaiters[callIndex]!.resolve(value);
  }
  settleUnequip(callIndex: number, value = true): void {
    this.unequipWaiters[callIndex]!.resolve(value);
  }
  get equipCallCount(): number {
    return this.equipWaiters.length;
  }
  get unequipCallCount(): number {
    return this.unequipWaiters.length;
  }
}

describe("T2 — different-slot concurrent equips must never clobber each other (design §4.1's own bug)", () => {
  it("a helmet equip resolving first does not drop a still-in-flight, unrelated armor equip's verdict", async () => {
    const store = new MultiSlotControlledStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-cross-slot-1");
      await flush(); // let the (empty) join-time hydration settle so it cannot interfere below

      equipItem(room, client, "leather-armor", "armor");
      equipItem(room, client, "old-dagger", "weapon");
      assert.equal(store.equipCallCount, 2, "both requests must reach the store independently");
      assert.equal(client.userData?.equipRequestPendingSlots.has("armor"), true);
      assert.equal(client.userData?.equipRequestPendingSlots.has("weapon"), true);

      // The weapon request settles first — out of request order, the realistic case for two
      // genuinely concurrent round trips.
      store.settleEquip(1, true);
      await flush();
      assert.equal(client.userData?.equippedItemKeys.weapon, "old-dagger", "the weapon request applied");
      assert.equal(
        client.userData?.equipRequestPendingSlots.has("armor"),
        true,
        "the still-in-flight armor request must be untouched by the weapon request settling",
      );

      store.settleEquip(0, true);
      await flush();
      assert.equal(
        client.userData?.equippedItemKeys.armor,
        "leather-armor",
        "BUG (design §4.1): with one shared equipCacheVersion this verdict would be silently dropped " +
          "because the weapon write already bumped the (would-be-shared) counter",
      );

      assert.deepEqual(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged),
        [
          { slot: "weapon", itemKey: "old-dagger", applied: true },
          { slot: "armor", itemKey: "leather-armor", applied: true },
        ],
        "both requests must each receive their own verdict — neither is silently swallowed",
      );
    } finally {
      dispose(room);
    }
  });

  it("the reverse settlement order (armor first, then weapon) is symmetric", async () => {
    const store = new MultiSlotControlledStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-cross-slot-2");
      await flush();

      equipItem(room, client, "leather-armor", "armor");
      equipItem(room, client, "old-dagger", "weapon");

      store.settleEquip(0, true);
      await flush();
      assert.equal(client.userData?.equippedItemKeys.armor, "leather-armor");

      store.settleEquip(1, true);
      await flush();
      assert.equal(client.userData?.equippedItemKeys.weapon, "old-dagger");

      assert.deepEqual(sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged), [
        { slot: "armor", itemKey: "leather-armor", applied: true },
        { slot: "weapon", itemKey: "old-dagger", applied: true },
      ]);
    } finally {
      dispose(room);
    }
  });

  it("three different slots (armor/weapon/helmet-family via ring1) racing at once all land independently", async () => {
    const store = new MultiSlotControlledStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-cross-slot-3");
      await flush();

      // ring1 bypasses handleEquipItem's catalogue gate the same way `armorEquip-verification
      // .test.ts`'s own real-DB race test bypasses it for a second armor item — the catalogue
      // having no ring item yet is a business-data fact, orthogonal to the per-slot concurrency
      // mechanism under test.
      room["settleEquipRequest"](
        asRoomClient(client),
        "ring1",
        () => store.equip("sso-cross-slot-3", "phantom-ring", "ring1"),
        "phantom-ring",
      );
      equipItem(room, client, "leather-armor", "armor");
      equipItem(room, client, "old-dagger", "weapon");
      assert.equal(store.equipCallCount, 3);

      // Settle in yet another order: ring1, then armor, then weapon.
      store.settleEquip(0, true);
      await flush();
      store.settleEquip(1, true);
      await flush();
      store.settleEquip(2, true);
      await flush();

      assert.deepEqual(client.userData?.equippedItemKeys, {
        ring1: "phantom-ring",
        armor: "leather-armor",
        weapon: "old-dagger",
      });
      assert.equal(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged).length,
        3,
        "every one of the three independent slot requests gets its own verdict",
      );
    } finally {
      dispose(room);
    }
  });

  it("PROOF: the same interleaving genuinely drops a verdict if the per-slot counters were (as design §4.1 warns) one shared counter", async () => {
    // This does not touch metaverseRoom.ts or contracts.ts — it drives the real, unmodified
    // `settleEquipRequest` against a *rigged session* whose `equipCacheVersions` is a Proxy that
    // makes every slot read/write the same one number, which is externally indistinguishable from
    // the single-counter code design §4.1 describes as the pre-fix bug. If this fails to reproduce
    // the drop, the tests above prove nothing about which counter shape they are sensitive to.
    let shared = 0;
    const sharedVersionProxy = new Proxy({} as Record<EquipmentSlot, number>, {
      get: () => shared,
      set: (_target, _prop, value) => {
        shared = value as number;
        return true;
      },
    });

    const store = new MultiSlotControlledStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-cross-slot-proof");
      await flush();
      // Replace the real, per-slot-independent versions with the rigged shared one, after the
      // (already-settled) join hydration, so only the two equip requests below are affected.
      client.userData!.equipCacheVersions = sharedVersionProxy;

      equipItem(room, client, "leather-armor", "armor");
      equipItem(room, client, "old-dagger", "weapon");

      store.settleEquip(1, true); // weapon settles first and bumps the shared counter
      await flush();
      assert.equal(client.userData?.equippedItemKeys.weapon, "old-dagger");

      store.settleEquip(0, true); // armor's own store call also truly succeeded
      await flush();

      assert.equal(
        client.userData?.equippedItemKeys.armor,
        undefined,
        "reproduced: under a shared counter, armor's genuinely-successful equip is discarded by the cache " +
          "because it now looks like a stale response — exactly the failure design §4.1 names",
      );
      assert.equal(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged).filter((m) => m.slot === "armor")
          .length,
        0,
        "reproduced: the client receives no EquipmentChanged at all for the armor request — a silent drop, " +
          "not even a applied:false verdict",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("T2a — same-slot concurrency still behaves like Phase F (regression check, room level)", () => {
  it("two requests racing for the *same* slot: the later store settlement is the one whose version compare must fail", async () => {
    const store = new MultiSlotControlledStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-same-slot-1");
      await flush();

      equipItem(room, client, "leather-armor", "armor");
      assert.equal(client.userData?.equipRequestPendingSlots.has("armor"), true);
      // A second request for the *same* slot while the first is in flight is dropped outright by
      // `equipRequestPendingSlots` before it ever reaches the store — Phase F's own behaviour,
      // unchanged by the slot expansion (`handleEquipItem`'s own pending-slot guard).
      unequipItem(room, client, "armor");
      assert.equal(store.equipCallCount, 1, "the overlapping same-slot request must never reach the store");

      store.settleEquip(0, true);
      await flush();
      assert.equal(client.userData?.equippedItemKeys.armor, "leather-armor", "only the first request's result survives");
    } finally {
      dispose(room);
    }
  });
});

describe("T3 — ring1/ring2: independent slots of the same family", () => {
  it("equipping into ring2 does not disturb what is already in ring1", async () => {
    const store = new InMemoryInventoryStore();
    const owner = "sso-rings-1";
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", owner);
      await flush();
      await store.add(owner, "ring-of-agility", 1);
      await store.add(owner, "ring-of-power", 1);

      // Two distinct item keys, both of "ring" family conceptually — bypassing handleEquipItem's
      // catalogue gate the same way the cross-session real-DB test in armorEquip-verification.test.ts
      // does for a second armor item, since ITEM_DEFINITIONS ships no ring item yet (design §6.2).
      room["settleEquipRequest"](
        asRoomClient(client),
        "ring1",
        () => store.equip(owner, "ring-of-agility", "ring1"),
        "ring-of-agility",
      );
      await flush();
      room["settleEquipRequest"](
        asRoomClient(client),
        "ring2",
        () => store.equip(owner, "ring-of-power", "ring2"),
        "ring-of-power",
      );
      await flush();

      assert.deepEqual(client.userData?.equippedItemKeys, {
        ring1: "ring-of-agility",
        ring2: "ring-of-power",
      });
      assert.deepEqual(await store.getEquippedSlots(owner), {
        ring1: "ring-of-agility",
        ring2: "ring-of-power",
      });
    } finally {
      dispose(room);
    }
  });

  it("unequipping ring1 leaves ring2 in place", async () => {
    const store = new InMemoryInventoryStore();
    const owner = "sso-rings-2";
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", owner);
      await flush();
      await store.add(owner, "ring-a", 1);
      await store.add(owner, "ring-b", 1);
      await store.equip(owner, "ring-a", "ring1");
      await store.equip(owner, "ring-b", "ring2");
      // Rehydrate the session cache the same way a real join would (store state changed underneath it).
      await room["hydrateEquipmentCache"]("s1", owner);

      room["settleEquipRequest"](asRoomClient(client), "ring1", () => store.unequip(owner, "ring1"), null);
      await flush();

      assert.deepEqual(client.userData?.equippedItemKeys, { ring2: "ring-b" });
      assert.deepEqual(await store.getEquippedSlots(owner), { ring2: "ring-b" });
    } finally {
      dispose(room);
    }
  });

  it("two concurrent requests both naming ring1 (the same concrete slot) still race like any other same-slot pair", async () => {
    // handleUnequipItem needs no catalogue lookup (unlike handleEquipItem), so — unlike this file's
    // other ring tests — this one drives the real public entrypoint and its real
    // `equipRequestPendingSlots` guard for ring1 directly, without a bypass.
    const store = new MultiSlotControlledStore();
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-rings-race");
      await flush();

      unequipItem(room, client, "ring1");
      assert.equal(store.unequipCallCount, 1, "the first request reaches the store");
      assert.equal(client.userData?.equipRequestPendingSlots.has("ring1"), true);

      // A second attempt at ring1 while the first is in flight must be dropped by the pending-slot
      // guard, same as any other slot — ring1/ring2 need no special-cased contention handling
      // beyond the ordinary per-slot mechanism (design §4.4's own point).
      unequipItem(room, client, "ring1");
      assert.equal(store.unequipCallCount, 1, "the overlapping same-slot request must never reach the store");

      store.settleUnequip(0, true);
      await flush();
      assert.deepEqual(
        sentOfType<EquipmentChanged>(client, ServerMessage.EquipmentChanged),
        [{ slot: "ring1", itemKey: null, applied: true }],
        "exactly one verdict for the two messages sent",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("T4 — getEquippedSlots: one round trip for every slot, and the hasMonsters gate holds", () => {
  it("hydrateEquipmentCache populates every returned slot from a single call, not just one", async () => {
    let calls = 0;
    const answer: Partial<Record<EquipmentSlot, string>> = {
      armor: "leather-armor",
      weapon: "old-dagger",
      ring1: "ring-a",
      necklace: "amulet-x",
    };
    const store: InventoryStore = {
      list: () => Promise.resolve([]),
      add: () => Promise.resolve(null),
      grantOnce: () => Promise.resolve(false),
      getEquippedSlots: () => {
        calls += 1;
        return Promise.resolve(answer);
      },
      equip: () => Promise.resolve(false),
      unequip: () => Promise.resolve(false),
    };
    const room = await createRoom([INERT_SPAWN], store);
    try {
      const client = join(room, "s1", "sso-multi-hydrate");
      await flush();

      assert.equal(calls, 1, "the join-time catch-up read must be exactly one round trip regardless of slot count");
      assert.deepEqual(client.userData?.equippedItemKeys, answer, "every slot in the one answer must be applied");
    } finally {
      dispose(room);
    }
  });

  it("never calls getEquippedSlots on a grand-plaza-shaped join (no monsters), matching the possession cache's own gate", async () => {
    let calls = 0;
    const store: InventoryStore = {
      list: () => Promise.resolve([]),
      add: () => Promise.resolve(null),
      grantOnce: () => Promise.resolve(false),
      getEquippedSlots: () => {
        calls += 1;
        return Promise.resolve({});
      },
      equip: () => Promise.resolve(false),
      unequip: () => Promise.resolve(false),
    };
    // No monster spawns at all: `hasMonsters` is computed from `this.state.monsters.size > 0`
    // (metaverseRoom.ts:1484), so an empty spawn list is what a real grand-plaza-shaped room is.
    const room = await createRoom([], store);
    try {
      join(room, "s1", "sso-no-monsters");
      await flush();
      assert.equal(room["hasMonsters"], false, "precondition: this room has no monsters");
      assert.equal(calls, 0, "the 8-slot expansion must not turn a monster-less room into a DB round trip on join");
    } finally {
      dispose(room);
    }
  });
});

describe("T5 — damage reduction combines multiplicatively across slots, never reaching or exceeding 1", () => {
  it("armor + helmet + cloak, each carrying leather-armor's real 0.2 ratio, combine to 1-0.8^3 rather than a naive 0.6 sum", async () => {
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", MonsterKind.Squirrel, OPEN_CENTRE)], store);
    try {
      const victim = join(room, "victim", "sso-multi-reduction");
      place(room, "victim", OPEN_CENTRE);

      // Placing the *same*, real catalogue item into three different slots at once is a scenario
      // no live client can reach today (only the armor slot ever holds it) — it isolates the
      // combination formula (equippedDamageReduction) from the catalogue-population question that
      // §6.2 leaves for a later Phase, using only real, already-shipped stats (no fixture item).
      victim.userData!.equippedItemKeys = { armor: "leather-armor", helmet: "leather-armor", cloak: "leather-armor" };

      room["tick"](1000);
      const hit = sentOfType<PlayerHit>(victim, ServerMessage.PlayerHit).at(-1);

      const multiplicative = 1 - Math.pow(0.8, 3); // design §5.4's own 1-Π(1-rᵢ) — 0.488
      const naiveSum = 0.2 * 3; // the rejected alternative — 0.6
      assert.notEqual(multiplicative, naiveSum, "precondition: the two formulas must disagree for this test to mean anything");

      const expectedDamage = Math.max(1, Math.floor(100 * (1 - multiplicative)));
      const additiveDamage = Math.max(1, Math.floor(100 * (1 - naiveSum)));
      assert.notEqual(expectedDamage, additiveDamage, "precondition: the two formulas must predict different integers");
      assert.equal(hit?.damage, expectedDamage, "the applied damage must match the multiplicative combination, not a sum");
    } finally {
      dispose(room);
    }
  });

  it("no combination of high per-slot ratios ever reaches total damage reduction (never below the floor-to-1 guard, and never literal invincibility)", async () => {
    // A temporary catalogue fixture, restored in `finally` regardless of outcome — no source file
    // is edited; `ITEM_DEFINITIONS` is a plain array at runtime despite its `readonly` type, and
    // this is the only way to exercise the formula's asymptotic-but-never-1 behaviour, since the
    // shipped catalogue's only damage-reduction ratio (leather-armor's 0.2) cannot approach 1 no
    // matter how many slots hold it (1-0.8^8 ≈ 0.83, not remotely close to the boundary this test
    // is about).
    const highRatioFixture: ItemDefinition = {
      key: "test-only-fixture-overload-plate",
      name: "test fixture",
      icon: "test-fixture",
      equipment: { slot: "armor", stats: { damageReduction: 0.95 } },
    };
    const mutableDefinitions = ITEM_DEFINITIONS as ItemDefinition[];
    mutableDefinitions.push(highRatioFixture);

    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", MonsterKind.Squirrel, OPEN_CENTRE)], store);
    try {
      const victim = join(room, "victim", "sso-near-invincible");
      place(room, "victim", OPEN_CENTRE);

      // All eight slots at once, each at the fixture's 0.95 ratio: combined = 1 - 0.05^8, which is
      // 1 minus a number on the order of 1e-10 — as close to total reduction as this test can push
      // the formula, yet still mathematically < 1.
      victim.userData!.equippedItemKeys = {
        armor: highRatioFixture.key,
        helmet: highRatioFixture.key,
        ring1: highRatioFixture.key,
        ring2: highRatioFixture.key,
        necklace: highRatioFixture.key,
        shoes: highRatioFixture.key,
        weapon: highRatioFixture.key,
        cloak: highRatioFixture.key,
      };

      room["tick"](1000);
      const hit = sentOfType<PlayerHit>(victim, ServerMessage.PlayerHit).at(-1);

      const combined = 1 - Math.pow(1 - 0.95, 8);
      assert.ok(combined < 1, "the formula itself must never reach exactly 1 however many slots contribute");
      assert.equal(
        hit?.damage,
        1,
        "with combined reduction this close to total, the applied damage floors to the documented minimum of 1 " +
          "— an equipped player must stay killable no matter how many slots stack the same axis",
      );
      assert.ok(
        (victim.userData?.hp ?? 0) < 100,
        "damage must still be strictly positive — a wearer of eight near-maximal-reduction items is not literally unkillable",
      );
    } finally {
      const index = mutableDefinitions.indexOf(highRatioFixture);
      assert.ok(index >= 0, "the fixture must still be exactly where this test pushed it");
      mutableDefinitions.splice(index, 1);
      dispose(room);
    }
  });

  it("cleans up after itself: ITEM_DEFINITIONS is back to its original length for any test that runs after this file", () => {
    // A cheap, explicit sanity check on the previous test's own cleanup — this project's append-
    // only discipline for ITEM_DEFINITIONS (design §6.3) means a leaked fixture row would silently
    // change every other test file's catalogue lookups for the rest of this process's life.
    assert.equal(
      ITEM_DEFINITIONS.some((item) => item.key.startsWith("test-only-fixture-")),
      false,
      "no test fixture item may survive past its own test",
    );
  });
});

/**
 * The half of T2/T3 no in-process stub can reach: two genuinely concurrent connections racing
 * `PostgresInventoryStore.equip` for *different* slots on the same account. Opt-in, same convention
 * as `inventoryStore.test.ts` and `armorEquip-verification.test.ts`'s own real-database suites.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

describe(
  "T2/T3 — cross-slot and ring1/ring2 concurrency against a real database",
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

    it("two genuinely concurrent equip() calls into different slots on one account both commit, with no unique-index contention", async () => {
      const store = new PostgresInventoryStore(pool);
      const owner = randomUUID();
      await store.add(owner, "leather-armor", 1);
      await store.add(owner, "old-dagger", 1);

      const results = await Promise.allSettled([
        store.equip(owner, "leather-armor", "armor"),
        store.equip(owner, "old-dagger", "weapon"),
      ]);
      assert.equal(results.filter((r) => r.status === "rejected").length, 0, "neither call may reject");
      assert.deepEqual(
        (results as PromiseFulfilledResult<boolean>[]).map((r) => r.value),
        [true, true],
        "both concurrent equips into different slots must succeed — they never contend on the same index entry",
      );

      const rows = await store.list(owner);
      assert.equal(rows.filter((row) => row.equipped).length, 2, "both rows must end up equipped, in different slots");
      assert.deepEqual(await store.getEquippedSlots(owner), { armor: "leather-armor", weapon: "old-dagger" });
    });

    it("ring1 and ring2 on one account equip concurrently and independently, same as armor/weapon", async () => {
      const store = new PostgresInventoryStore(pool);
      const owner = randomUUID();
      await store.add(owner, "ring-fixture-a", 1);
      await store.add(owner, "ring-fixture-b", 1);

      const results = await Promise.allSettled([
        store.equip(owner, "ring-fixture-a", "ring1"),
        store.equip(owner, "ring-fixture-b", "ring2"),
      ]);
      assert.deepEqual(
        (results as PromiseFulfilledResult<boolean>[]).map((r) => r.value),
        [true, true],
      );
      assert.deepEqual(await store.getEquippedSlots(owner), { ring1: "ring-fixture-a", ring2: "ring-fixture-b" });
    });

    it("two concurrent equips both targeting ring1 still let exactly one win, same as the armor-slot race", async () => {
      const store = new PostgresInventoryStore(pool);
      const owner = randomUUID();
      await store.add(owner, "ring-fixture-c", 1);
      await store.add(owner, "ring-fixture-d", 1);

      const results = await Promise.allSettled([
        store.equip(owner, "ring-fixture-c", "ring1"),
        store.equip(owner, "ring-fixture-d", "ring1"),
      ]);
      assert.equal(results.filter((r) => r.status === "rejected").length, 0);
      const values = (results as PromiseFulfilledResult<boolean>[]).map((r) => r.value);
      assert.equal(values.filter((v) => v).length, 1, "exactly one of the two same-slot ring equips must win");

      const equipped = await store.getEquippedSlots(owner);
      assert.equal(Object.keys(equipped).length, 1);
      assert.equal(["ring-fixture-c", "ring-fixture-d"].includes(equipped.ring1 ?? ""), true);
    });
  },
);
