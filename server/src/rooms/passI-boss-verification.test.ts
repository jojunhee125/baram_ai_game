import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Direction,
  MONSTER_TICK_MS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_MAX_HP,
  type EquipmentSlot,
  type JoinOptions,
  type TilePosition,
} from "@zep-test/shared";
import type { BossStateStore } from "../db/bossStateStore";
import type { InventoryRow, InventoryStore } from "../db/inventoryStore";
import type { LandmarkIndex, RoomCreateOptions, SpawnArea } from "./contracts";
import { ROOM_DEFINITIONS } from "./definitions";
import { buildLootTableView } from "./lootTableView";
import { MetaverseRoom } from "./metaverseRoom";
import {
  BOSS_RESPAWN_MS,
  MONSTER_SPAWN_DEFINITIONS,
  MONSTER_TYPES,
  MonsterKind,
  type MonsterSpawnDefinition,
  type MonsterType,
} from "./monsterDefinitions";

/**
 * Phase I Pass T (`docs/design-phase-i-boss-monster.md` §8, rows T2-T6): everything about the
 * boss that lives in `metaverseRoom.ts` — the store-driven start state (§2.4), the tick-loop gate
 * that a dead-start boss put at risk (§6.4), the fire-and-forget defeat record (§2.5), the
 * `onJoin` population cap that replaced `maxClients` (§1.2), and the wipe reset (§6.6).
 *
 * Built on `passE-combat-verification.test.ts`'s harness rather than `@colyseus/testing`: every
 * one of these cases needs an exact `now`, and a live simulation timer would mutate the state
 * mid-assertion.
 *
 * The six defects this pass found were reported as `todo`-flagged reproductions and have since
 * been fixed; those rows are ordinary assertions now, and they are the regression tests for the
 * fixes. Two of them assert behaviour this file previously pinned as "what happens today" — a
 * store read that fails no longer refuses the room, and the last combatant leaving now declares a
 * wipe exactly as their death would (team lead's call, §6.6).
 */

/** design §11.4. Not exported by `metaverseRoom.ts`, so the assertions derive it from behaviour. */
const WIPE_RESET_GRACE_MS = 5000;

const OPEN_CENTRE: TilePosition = { tileX: 78, tileY: 70 };
/** Ten tiles from the room's home, so a player warped home by death falls out of aggro range. */
const BOSS_TILE: TilePosition = { tileX: OPEN_CENTRE.tileX + 10, tileY: OPEN_CENTRE.tileY };
const SQUIRREL_TILE: TilePosition = { tileX: OPEN_CENTRE.tileX + 20, tileY: OPEN_CENTRE.tileY };

const FIXTURE_BOSS_HP = 20;

/**
 * A boss shaped for tests, not for play: five player swings to kill (`FIXTURE_BOSS_HP` / 4) and
 * one swing back to kill a player, so a fight is a handful of deterministic calls. Only the two
 * fields the feature actually branches on are the real ones — `isBoss` and a `respawnDelayMs` of
 * `BOSS_RESPAWN_MS`, which is what `killMonster` counts the in-memory respawn from.
 */
const FIXTURE_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Boss,
    {
      kind: MonsterKind.Boss,
      isBoss: true,
      maxHp: FIXTURE_BOSS_HP,
      damage: PLAYER_MAX_HP,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 10,
      respawnDelayMs: BOSS_RESPAWN_MS,
      expReward: 600,
      loot: [],
    },
  ],
  [
    // A non-boss kind in the same room: the tracker must stay null on it, and a death it deals
    // is a death the boss's own roster has to account for (design §6.6).
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      maxHp: 8,
      damage: PLAYER_MAX_HP,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 10,
      respawnDelayMs: MONSTER_TICK_MS * 5,
      expReward: 4,
      loot: [],
    },
  ],
]);

// -- stores -------------------------------------------------------------------------------------

/** Records every call, so "the boss row and nothing else was read" is checkable. */
class RecordingBossStateStore implements BossStateStore {
  readonly reads: string[] = [];
  readonly writes: { spawnId: string; defeatedAtMs: number }[] = [];
  private readonly defeatedAt: Map<string, number>;

  constructor(seed: readonly (readonly [string, number])[] = []) {
    this.defeatedAt = new Map(seed.map(([spawnId, at]) => [spawnId, at]));
  }

  getLastDefeatedAt(spawnId: string): Promise<number | null> {
    this.reads.push(spawnId);
    return Promise.resolve(this.defeatedAt.get(spawnId) ?? null);
  }

  recordDefeat(spawnId: string, defeatedAtMs: number): Promise<void> {
    this.writes.push({ spawnId, defeatedAtMs });
    this.defeatedAt.set(spawnId, defeatedAtMs);
    return Promise.resolve();
  }
}

/**
 * Answers the creation-time read normally and then never answers the write. Proves the kill path
 * does not wait for it (design §2.5, §6.5): anything that awaited this would hang forever.
 */
class HangingBossStateStore implements BossStateStore {
  readonly writes: { spawnId: string; defeatedAtMs: number }[] = [];

  getLastDefeatedAt(): Promise<number | null> {
    return Promise.resolve(null);
  }

  recordDefeat(spawnId: string, defeatedAtMs: number): Promise<void> {
    this.writes.push({ spawnId, defeatedAtMs });
    return new Promise(() => {});
  }
}

/** A database that is down: both calls reject, which is what `PostgresBossStateStore` does. */
class FailingBossStateStore implements BossStateStore {
  constructor(private readonly failReads = true) {}

  getLastDefeatedAt(): Promise<number | null> {
    return this.failReads
      ? Promise.reject(new Error("connection terminated unexpectedly"))
      : Promise.resolve(null);
  }

  recordDefeat(): Promise<void> {
    return Promise.reject(new Error("connection terminated unexpectedly"));
  }
}

/** Answers `list` only after a delay, so two joins can interleave across the gate's own await. */
class SlowPassInventoryStore implements InventoryStore {
  constructor(private readonly delayMs: number) {}

  async list(): Promise<readonly InventoryRow[]> {
    await sleep(this.delayMs);
    return [{ itemKey: "entry-pass", quantity: 1, equipped: false }];
  }

  add(): Promise<number | null> {
    return Promise.resolve(1);
  }

  grantOnce(): Promise<boolean> {
    return Promise.resolve(true);
  }

  getEquippedSlots(): Promise<Partial<Record<EquipmentSlot, string>>> {
    return Promise.resolve({});
  }

  equip(): Promise<boolean> {
    return Promise.resolve(true);
  }

  unequip(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

// -- harness ------------------------------------------------------------------------------------

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

function asRoomClient(client: FakeClient): RoomClient {
  return client as unknown as RoomClient;
}

class BossRoom extends MetaverseRoom {
  fixtureSpawns: readonly MonsterSpawnDefinition[] = [];
  fixtureTypes: ReadonlyMap<MonsterKind, MonsterType> = FIXTURE_TYPES;
  fixtureLandmark: LandmarkIndex | null = null;
  randomValue = 0.5;
  /** Every `setSimulationInterval` call's delay — length 0 means the tick loop never started. */
  readonly simulationStarts: number[] = [];
  simulationCallback: ((deltaTime: number) => void) | null = null;

  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return this.fixtureSpawns;
  }

  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return this.fixtureTypes;
  }

  protected override random(): number {
    return this.randomValue;
  }

  protected override createLandmarkIndex(home: SpawnArea): LandmarkIndex {
    return this.fixtureLandmark ?? super.createLandmarkIndex(home);
  }

  override setSimulationInterval(callback?: (deltaTime: number) => void, delay?: number): void {
    // Recorded instead of started: a live timer would mutate state mid-assertion, and whether it
    // was started at all is itself what design §6.4 is about.
    this.simulationStarts.push(delay ?? -1);
    this.simulationCallback = callback ?? null;
  }
}

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "verify-boss",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
};

function bossAt(id: string, at: TilePosition): MonsterSpawnDefinition {
  return {
    id,
    room: ROOM_OPTIONS.roomType,
    kind: MonsterKind.Boss,
    at,
    wanderRadiusTiles: 0,
    persistentRespawn: true,
  };
}

function squirrelAt(id: string, at: TilePosition): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind: MonsterKind.Squirrel, at, wanderRadiusTiles: 0 };
}

async function createRoom(
  spawns: readonly MonsterSpawnDefinition[],
  overrides: Partial<RoomCreateOptions> = {},
  configure: (room: BossRoom) => void = () => {},
): Promise<BossRoom> {
  const room = new BossRoom();
  room.fixtureSpawns = spawns;
  configure(room);
  await room.onCreate({ ...ROOM_OPTIONS, ...overrides });
  return room;
}

/** A room built from a real `ROOM_DEFINITIONS` row and the real monster tables. */
async function createRealRoom(name: string, store?: BossStateStore): Promise<BossRoom> {
  const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `ROOM_DEFINITIONS has no "${name}" row`);
  const room = new BossRoom();
  room.fixtureSpawns = MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === name);
  room.fixtureTypes = MONSTER_TYPES;
  await room.onCreate({
    roomType: definition.roomType,
    mapKey: definition.mapKey,
    maxClients: definition.maxClients,
    realCapacity: definition.realCapacity,
    spawn: definition.spawn,
    bossStateStore: store,
  });
  return room;
}

function join(
  room: MetaverseRoom,
  sessionId: string,
  options?: Partial<JoinOptions>,
  ssoUserId: string | null = null,
): FakeClient {
  const client = fakeClient(sessionId, ssoUserId);
  void room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
  return client;
}

async function joinAsync(
  room: MetaverseRoom,
  sessionId: string,
  options?: Partial<JoinOptions>,
): Promise<FakeClient> {
  const client = fakeClient(sessionId);
  await room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
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

function attack(room: MetaverseRoom, client: FakeClient, at = 0): void {
  if (client.userData) {
    client.userData.lastAttackAt = at;
  }
  room["handleAttack"](asRoomClient(client));
}

function kill(room: MetaverseRoom, victim: string, monsterId: string, now: number): void {
  room["damagePlayer"](victim, monsterId, PLAYER_MAX_HP, now);
}

function runtimeOf(room: MetaverseRoom, monsterId: string) {
  const runtime = room["monsterRuntimes"].get(monsterId);
  assert.ok(runtime, `no runtime for "${monsterId}"`);
  return runtime;
}

function trackerOf(room: MetaverseRoom, monsterId: string) {
  const { combat } = runtimeOf(room, monsterId);
  assert.ok(combat, `"${monsterId}" has no boss combat tracker`);
  return combat;
}

function rosterOf(room: MetaverseRoom, monsterId: string): string[] {
  return [...trackerOf(room, monsterId).combatants].sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lets a fire-and-forget store call settle (and any rejection reach the process). */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

/** Brings a boss down to `hp` with real swings from `client`, standing where it stands. */
function swingUntil(room: BossRoom, client: FakeClient, monsterId: string, hp: number): void {
  const runtime = runtimeOf(room, monsterId);
  let guard = 0;
  while (runtime.hp > hp) {
    assert.ok(guard++ < 64, "swing loop made no progress");
    const monster = room.state.monsters.get(monsterId);
    assert.ok(monster, `"${monsterId}" is not on the map`);
    place(room, client.sessionId, { tileX: monster.tileX - 1, tileY: monster.tileY });
    face(room, client.sessionId, Direction.Right);
    attack(room, client, 0);
  }
  assert.equal(runtime.hp, hp);
}

// -- T2: the start state comes from the store --------------------------------------------------

describe("VERIFY T2 — a boss row's start state is read from the store at room creation", () => {
  it("starts dead with the exact remaining countdown when the last defeat is inside the window", async () => {
    const defeatedAt = Date.now() - 60 * 60 * 1000;
    const store = new RecordingBossStateStore([["boss", defeatedAt]]);
    const room = await createRoom([bossAt("boss", BOSS_TILE), squirrelAt("sq", SQUIRREL_TILE)], {
      bossStateStore: store,
    });
    try {
      const runtime = runtimeOf(room, "boss");
      assert.equal(runtime.state, "dead", "an hour after a defeat the boss is still down");
      assert.equal(room.state.monsters.has("boss"), false, "and it is not on the map");
      assert.equal(
        runtime.respawnAt,
        defeatedAt + BOSS_RESPAWN_MS,
        "the countdown is the remainder of the original 6 hours, not a fresh 6 hours",
      );
      assert.equal(runtime.hp, FIXTURE_BOSS_HP, "it will arrive whole when it does arrive");
      assert.equal(room.state.monsters.has("sq"), true, "every other row still starts alive");
      assert.deepEqual(store.reads, ["boss"], "only the boss row is looked up");
      assert.deepEqual(store.writes, [], "reading a start state writes nothing");
    } finally {
      dispose(room);
    }
  });

  it("starts alive the instant the window has elapsed, and one millisecond before it has not", async () => {
    // The comparison is `now - defeatedAt < BOSS_RESPAWN_MS`, so a defeat exactly one window old
    // is already respawned. Both sides of the boundary, with the margin on the dead side wide
    // enough that the wall clock advancing between these two lines cannot flip it.
    const elapsed = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new RecordingBossStateStore([["boss", Date.now() - BOSS_RESPAWN_MS]]),
    });
    try {
      assert.equal(runtimeOf(elapsed, "boss").state, "idle");
      assert.equal(elapsed.state.monsters.has("boss"), true);
    } finally {
      dispose(elapsed);
    }

    const almost = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new RecordingBossStateStore([["boss", Date.now() - BOSS_RESPAWN_MS + 1000]]),
    });
    try {
      assert.equal(runtimeOf(almost, "boss").state, "dead", "a second short of the window is still dead");
    } finally {
      dispose(almost);
    }
  });

  it("starts alive when the boss has never been defeated, and when no store is wired at all", async () => {
    const store = new RecordingBossStateStore();
    const fresh = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      assert.equal(runtimeOf(fresh, "boss").state, "idle", "null is 'never killed', not 'killed at 0'");
      assert.equal(fresh.state.monsters.has("boss"), true);
      assert.deepEqual(store.reads, ["boss"]);
    } finally {
      dispose(fresh);
    }

    const storeless = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      assert.equal(runtimeOf(storeless, "boss").state, "idle");
      assert.equal(storeless.state.monsters.has("boss"), true, "no store means every boss starts alive");
    } finally {
      dispose(storeless);
    }
  });

  it("treats a defeat recorded at epoch 0 as a defeat, not as 'never defeated'", async () => {
    // 0 is 1970, which is well past the window, so this must start *alive* — but for the right
    // reason: `getLastDefeatedAt` answering 0 has to reach the comparison rather than be read as
    // null somewhere on the way.
    const store = new RecordingBossStateStore([["boss", 0]]);
    const room = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      assert.equal(runtimeOf(room, "boss").state, "idle");
      assert.deepEqual(store.reads, ["boss"]);
    } finally {
      dispose(room);
    }
  });

  it("keeps a dead-start boss out of every client's monster view, and puts it in on respawn", async () => {
    const defeatedAt = Date.now() - 60 * 60 * 1000;
    const room = await createRoom([bossAt("boss", BOSS_TILE), squirrelAt("sq", SQUIRREL_TILE)], {
      bossStateStore: new RecordingBossStateStore([["boss", defeatedAt]]),
    });
    try {
      const watcher = join(room, "watcher");
      place(room, watcher.sessionId, { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      const viewed = room["monstersViewedBySession"].get("watcher");
      assert.ok(viewed);
      assert.equal(viewed.has("boss"), false, "a client cannot be told about a monster that is not there");

      room["tick"](defeatedAt + BOSS_RESPAWN_MS);
      assert.equal(room.state.monsters.has("boss"), true, "the countdown reached zero");
      assert.equal(
        room["monstersViewedBySession"].get("watcher")?.has("boss"),
        true,
        "and the respawn reached the watcher's view the way any spawn does",
      );
    } finally {
      dispose(room);
    }
  });

  it("gives hunting-ground's real boss row a dead start and leaves its other 20 alive", async () => {
    const defeatedAt = Date.now() - 2 * 60 * 60 * 1000;
    const store = new RecordingBossStateStore([["hg-boss-01", defeatedAt]]);
    const room = await createRealRoom("hunting-ground", store);
    try {
      assert.equal(room["monsterRuntimes"].size, 21, "21 spawn rows (20 + the boss)");
      assert.equal(room.state.monsters.size, 20, "the boss is the only one absent");
      assert.equal(runtimeOf(room, "hg-boss-01").state, "dead");
      assert.equal(runtimeOf(room, "hg-boss-01").respawnAt, defeatedAt + BOSS_RESPAWN_MS);
      assert.deepEqual(store.reads, ["hg-boss-01"], "20 squirrel/rabbit rows read nothing");
      assert.equal(room["hasMonsters"], true);
    } finally {
      dispose(room);
    }
  });

  it("gives hunting-den's real boss row a dead start and leaves its other 10 alive", async () => {
    const defeatedAt = Date.now() - 5 * 60 * 60 * 1000;
    const store = new RecordingBossStateStore([["hd-boss-01", defeatedAt]]);
    const room = await createRealRoom("hunting-den", store);
    try {
      assert.equal(room["monsterRuntimes"].size, 11);
      assert.equal(room.state.monsters.size, 10);
      assert.equal(runtimeOf(room, "hd-boss-01").state, "dead");
      assert.equal(runtimeOf(room, "hd-boss-01").respawnAt, defeatedAt + BOSS_RESPAWN_MS);
      assert.deepEqual(store.reads, ["hd-boss-01"]);
    } finally {
      dispose(room);
    }
  });

  it("keeps the two real zones' timers independent: one down does not take the other with it", async () => {
    const store = new RecordingBossStateStore([["hg-boss-01", Date.now() - 60_000]]);
    const ground = await createRealRoom("hunting-ground", store);
    const den = await createRealRoom("hunting-den", store);
    try {
      assert.equal(runtimeOf(ground, "hg-boss-01").state, "dead");
      assert.equal(runtimeOf(den, "hd-boss-01").state, "idle", "the den's boss was never defeated");
      assert.equal(den.state.monsters.size, 11);
    } finally {
      dispose(ground);
      dispose(den);
    }
  });

  it("starts both real bosses alive when the store has nothing for them", async () => {
    const store = new RecordingBossStateStore();
    const ground = await createRealRoom("hunting-ground", store);
    const den = await createRealRoom("hunting-den", store);
    try {
      assert.equal(ground.state.monsters.size, 21);
      assert.equal(den.state.monsters.size, 11);
      assert.deepEqual(store.reads, ["hg-boss-01", "hd-boss-01"]);
    } finally {
      dispose(ground);
      dispose(den);
    }
  });

  it("keeps the real boss type's respawn delay equal to the window populateMonsters compares", async () => {
    // `killMonster` counts the in-memory respawn from `type.respawnDelayMs`; `populateMonsters`
    // counts the cross-restart one from `BOSS_RESPAWN_MS`. Nothing enforces that the two agree,
    // so a boss kind authored with a different delay would respawn at two different times
    // depending on whether the room survived.
    const boss = MONSTER_TYPES.get(MonsterKind.Boss);
    assert.ok(boss);
    assert.equal(boss.respawnDelayMs, BOSS_RESPAWN_MS);
    for (const [kind, type] of MONSTER_TYPES) {
      if (type.isBoss === true) {
        assert.equal(type.respawnDelayMs, BOSS_RESPAWN_MS, `boss kind "${kind}" must use the window`);
      }
    }
  });

  it("still builds both real hunting rooms whole when the store read fails", async () => {
    // What the fallback is for: an unhandled read rejection used to fail `onCreate` itself, taking
    // hunting-ground's other 20 monsters — and its movement and its chat — down with one Postgres
    // hiccup. A *boot*-time database failure is still fatal, deliberately; that is `index.ts`'s
    // decision and this is a different moment.
    const store = new FailingBossStateStore();
    const ground = await createRealRoom("hunting-ground", store);
    const den = await createRealRoom("hunting-den", store);
    try {
      assert.equal(ground.state.monsters.size, 21, "every row placed, the boss included");
      assert.equal(den.state.monsters.size, 11);
      assert.equal(runtimeOf(ground, "hg-boss-01").state, "idle", "unreadable is alive, not dead");
      assert.equal(runtimeOf(den, "hd-boss-01").state, "idle");
      assert.deepEqual(ground.simulationStarts, [MONSTER_TICK_MS], "and the loop still started");
    } finally {
      dispose(ground);
      dispose(den);
    }
  });

  it("starts the boss alive rather than failing the whole room when the store read fails", async () => {
    const room = new BossRoom();
    room.fixtureSpawns = [bossAt("boss", BOSS_TILE), squirrelAt("sq", SQUIRREL_TILE)];
    await room.onCreate({ ...ROOM_OPTIONS, bossStateStore: new FailingBossStateStore() });
    try {
      assert.equal(room.state.monsters.has("sq"), true);
      assert.equal(room.state.monsters.has("boss"), true);
    } finally {
      dispose(room);
    }
  });
});

// -- T3: the tick-loop gate (design §6.4) -------------------------------------------------------

describe("VERIFY T3 — the tick loop is gated on the spawn table, not on what is alive", () => {
  it("starts the loop in a room whose only monster row starts dead", async () => {
    // The §6.4 regression: gated on `state.monsters.size` this room would never tick, and its
    // boss would never respawn for as long as the instance lived.
    const defeatedAt = Date.now() - 60_000;
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new RecordingBossStateStore([["boss", defeatedAt]]),
    });
    try {
      assert.equal(room.state.monsters.size, 0, "precondition: nothing is alive in this room");
      assert.deepEqual(room.simulationStarts, [MONSTER_TICK_MS], "the loop still started");
      assert.equal(room["hasMonsters"], true, "and the room knows it owns monsters");
      assert.ok(room.simulationCallback, "with a callback that drives the tick");
    } finally {
      dispose(room);
    }
  });

  it("counts a dead-start boss down and respawns it on the deadline, not a tick early", async () => {
    const defeatedAt = Date.now() - 60_000;
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new RecordingBossStateStore([["boss", defeatedAt]]),
    });
    try {
      const respawnAt = defeatedAt + BOSS_RESPAWN_MS;
      room["tick"](respawnAt - 1);
      assert.equal(room.state.monsters.has("boss"), false, "one millisecond early is still dead");
      assert.equal(runtimeOf(room, "boss").state, "dead");

      room["tick"](respawnAt);
      assert.equal(room.state.monsters.has("boss"), true, "exactly on the deadline it comes back");
      assert.equal(runtimeOf(room, "boss").state, "idle");
      assert.equal(runtimeOf(room, "boss").hp, FIXTURE_BOSS_HP, "whole");
      const monster = room.state.monsters.get("boss");
      assert.deepEqual(
        { tileX: monster?.tileX, tileY: monster?.tileY },
        { tileX: BOSS_TILE.tileX, tileY: BOSS_TILE.tileY },
        "on its own spawn tile",
      );
    } finally {
      dispose(room);
    }
  });

  it("still starts no loop, and builds no index, in a room with no spawn rows", async () => {
    const room = await createRoom([]);
    try {
      assert.deepEqual(room.simulationStarts, [], "grand-plaza's cost must not move");
      assert.equal(room["hasMonsters"], false);
    } finally {
      dispose(room);
    }
  });

  it("starts the loop for the real hunting rooms with their boss down", async () => {
    const store = new RecordingBossStateStore([
      ["hg-boss-01", Date.now() - 60_000],
      ["hd-boss-01", Date.now() - 60_000],
    ]);
    const ground = await createRealRoom("hunting-ground", store);
    const den = await createRealRoom("hunting-den", store);
    try {
      assert.deepEqual(ground.simulationStarts, [MONSTER_TICK_MS]);
      assert.deepEqual(den.simulationStarts, [MONSTER_TICK_MS]);
    } finally {
      dispose(ground);
      dispose(den);
    }
  });
});

// -- T4: the defeat record never blocks the tick ------------------------------------------------

describe("VERIFY T4 — the defeat record is fire-and-forget", () => {
  it("finishes the kill before the store answers, and never awaits it", async () => {
    const store = new HangingBossStateStore();
    const room = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      const killer = join(room, "killer");
      const before = Date.now();
      swingUntil(room, killer, "boss", PLAYER_ATTACK_DAMAGE);
      const monster = room.state.monsters.get("boss");
      assert.ok(monster);
      place(room, "killer", { tileX: monster.tileX - 1, tileY: monster.tileY });
      face(room, "killer", Direction.Right);
      attack(room, killer, 0);

      // Asserted in the same synchronous turn as the killing blow: a store call that was awaited
      // could not have got this far, because this store never resolves.
      assert.equal(room.state.monsters.has("boss"), false, "the boss left the map immediately");
      const runtime = runtimeOf(room, "boss");
      assert.equal(runtime.state, "dead");
      assert.equal(store.writes.length, 1, "exactly one defeat was recorded");
      const write = store.writes[0];
      assert.ok(write);
      assert.equal(write.spawnId, "boss");
      assert.ok(
        write.defeatedAtMs >= before && write.defeatedAtMs <= Date.now(),
        "the timestamp is the server's own clock at the kill",
      );
      assert.equal(
        runtime.respawnAt,
        write.defeatedAtMs + BOSS_RESPAWN_MS,
        "the in-memory countdown and the recorded time agree, so both paths respawn together",
      );

      // And the loop keeps running with the write still in flight.
      room["tick"](write.defeatedAtMs + 1000);
      assert.equal(room.state.monsters.has("boss"), false);
      await flush();
      assert.equal(store.writes.length, 1, "a tick does not re-record a defeat");
    } finally {
      dispose(room);
    }
  });

  it("records nothing for a non-boss kill, and nothing at all with no store", async () => {
    const store = new RecordingBossStateStore();
    const room = await createRoom([squirrelAt("sq", BOSS_TILE)], { bossStateStore: store });
    try {
      const killer = join(room, "killer");
      place(room, "killer", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "killer", Direction.Right);
      attack(room, killer, 0);
      attack(room, killer, 0);
      await flush();
      assert.equal(room.state.monsters.has("sq"), false, "the squirrel died");
      assert.deepEqual(store.writes, [], "and its death is nobody's 6-hour timer");
      assert.deepEqual(store.reads, [], "nor was it read at creation");
    } finally {
      dispose(room);
    }

    const storeless = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const killer = join(storeless, "killer");
      swingUntil(storeless, killer, "boss", 0);
      await flush();
      assert.equal(storeless.state.monsters.has("boss"), false, "the kill still resolves");
    } finally {
      dispose(storeless);
    }
  });

  it("lets the later of two instances' records decide what a room created afterwards sees", async () => {
    // design §2.3/§1.1: two live instances of the same room both write this spawn id. Neither
    // learns about the other, but the next instance to be created must see one coherent deadline.
    const store = new RecordingBossStateStore();
    const first = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    const second = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      const a = join(first, "a");
      const b = join(second, "b");
      swingUntil(first, a, "boss", 0);
      swingUntil(second, b, "boss", 0);
      await flush();
      assert.equal(store.writes.length, 2, "both instances recorded the kill they saw");
      const last = store.writes.at(-1);
      assert.ok(last);

      const third = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
      try {
        assert.equal(runtimeOf(third, "boss").state, "dead");
        assert.equal(
          runtimeOf(third, "boss").respawnAt,
          last.defeatedAtMs + BOSS_RESPAWN_MS,
          "the later write is the one the next room instance counts from",
        );
      } finally {
        dispose(third);
      }
    } finally {
      dispose(first);
      dispose(second);
    }
  });

  it("survives a defeat record that fails, the way a failed loot grant does", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new FailingBossStateStore(false),
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const killer = join(room, "killer");
      swingUntil(room, killer, "boss", 0);
      await flush();
      assert.equal(room.state.monsters.has("boss"), false, "the kill resolves regardless");
      assert.deepEqual(
        unhandled,
        [],
        "a store failure must be caught where it happens — awardLoot's own rule (design §2.5)",
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      dispose(room);
    }
  });
});

// -- T5: the real population cap (design §1.2) --------------------------------------------------

describe("VERIFY T5 — onJoin enforces the real capacity, maxClients no longer does", () => {
  it("refuses the join that would exceed realCapacity and admits exactly that many", async () => {
    const room = await createRoom([], { realCapacity: 3 });
    try {
      await joinAsync(room, "a");
      await joinAsync(room, "b");
      await joinAsync(room, "c");
      assert.equal(room.state.players.size, 3);
      await assert.rejects(() => joinAsync(room, "d"), /is full/);
      assert.equal(room.state.players.size, 3, "the refusal admitted nobody");
    } finally {
      dispose(room);
    }
  });

  it("leaves no bookkeeping behind for the session it refused", async () => {
    const room = await createRoom([], { realCapacity: 1 });
    try {
      await joinAsync(room, "a");
      await assert.rejects(() => joinAsync(room, "refused"), /is full/);
      assert.equal(room["clientsBySession"].has("refused"), false);
      assert.equal(room["viewedBySession"].has("refused"), false);
      assert.equal(room["monstersViewedBySession"].has("refused"), false);
      assert.equal(room.state.players.has("refused"), false);
    } finally {
      dispose(room);
    }
  });

  it("frees the seat again when somebody leaves", async () => {
    const room = await createRoom([], { realCapacity: 1 });
    try {
      const first = await joinAsync(room, "a");
      await assert.rejects(() => joinAsync(room, "b"), /is full/);
      room.onLeave(asRoomClient(first));
      await joinAsync(room, "b");
      assert.equal(room.state.players.size, 1);
      assert.equal(room.state.players.has("b"), true);
    } finally {
      dispose(room);
    }
  });

  it("falls back to maxClients where no realCapacity is configured", async () => {
    const room = await createRoom([], { maxClients: 2, realCapacity: undefined });
    try {
      await joinAsync(room, "a");
      await joinAsync(room, "b");
      await assert.rejects(() => joinAsync(room, "c"), /is full/);
    } finally {
      dispose(room);
    }
  });

  it("keeps the real table's two hunting rooms on a reachable-only-by-onJoin cap", async () => {
    const rows = new Map(ROOM_DEFINITIONS.map((definition) => [definition.name, definition]));
    const ground = rows.get("hunting-ground");
    const den = rows.get("hunting-den");
    assert.ok(ground && den);
    assert.equal(ground.maxClients, 500, "matchmaking must never see this room fill up");
    assert.equal(ground.realCapacity, 40, "the gameplay cap PoC #3 was measured against");
    assert.equal(den.maxClients, 500);
    assert.equal(den.realCapacity, 20);
    for (const definition of ROOM_DEFINITIONS) {
      const real = definition.realCapacity ?? definition.maxClients;
      assert.ok(
        real <= definition.maxClients,
        `"${definition.name}" would refuse joins the matchmaker still routes to it`,
      );
    }
    assert.equal(rows.get("grand-plaza")?.realCapacity, undefined, "no other room changed shape");
  });

  it("enforces hunting-den's real 20 on a room built from the real row", async () => {
    const room = await createRealRoom("hunting-den", new RecordingBossStateStore());
    try {
      for (let index = 0; index < 20; index++) {
        await joinAsync(room, `hunter-${index}`);
      }
      assert.equal(room.state.players.size, 20);
      // `roomName` is the matchmaker's, and a room built without one names itself "undefined" —
      // the real message is asserted end to end in `passI-boss-capacity.integration.test.ts`.
      await assert.rejects(() => joinAsync(room, "hunter-20"), /is full/);
    } finally {
      dispose(room);
    }
  });

  it("holds the cap when gated-landmark joins arrive at the same moment", async () => {
    // The gated landmark path (`arriveAtLandmark` + `requiresItemKey`, which is exactly how
    // hunting-den is entered) awaits an inventory round trip *between* the cap check and the
    // insert, so concurrent joins all see the same pre-await count — the seat has to be checked
    // again on the far side of that await.
    const room = await createRoom([], { realCapacity: 1, inventoryStore: new SlowPassInventoryStore(30) }, (fixture) => {
      fixture.fixtureLandmark = {
        resolve: () => ({
          area: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
          requiresItemKey: "entry-pass",
        }),
      };
    });
    try {
      const results = await Promise.allSettled([
        joinAsync(room, "a", { arriveAtLandmark: "landmark-hunting-den" }),
        joinAsync(room, "b", { arriveAtLandmark: "landmark-hunting-den" }),
        joinAsync(room, "c", { arriveAtLandmark: "landmark-hunting-den" }),
      ]);
      const admitted = results.filter((result) => result.status === "fulfilled").length;
      assert.equal(room.state.players.size, 1, `${admitted} joins were admitted past a cap of 1`);
      assert.equal(admitted, 1, "and the two refusals were reported to their callers as refusals");
      for (const result of results) {
        if (result.status === "rejected") {
          assert.match(String(result.reason), /is full/);
        }
      }
    } finally {
      dispose(room);
    }
  });
});

// -- T6: the wipe reset (design §6.6) -----------------------------------------------------------

describe("VERIFY T6 — a wipe resets the boss, one death does not", () => {
  it("gives the tracker only to boss runtimes", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE), squirrelAt("sq", SQUIRREL_TILE)]);
    try {
      assert.ok(runtimeOf(room, "boss").combat, "the boss has a roster");
      assert.equal(runtimeOf(room, "sq").combat, null, "nothing else does");
      assert.deepEqual(rosterOf(room, "boss"), [], "and it starts empty");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null);
    } finally {
      dispose(room);
    }
  });

  it("enrols whoever swings at the boss and whoever the boss swings at", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const swinger = join(room, "swinger");
      const victim = join(room, "victim");
      place(room, "swinger", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      place(room, "victim", { tileX: BOSS_TILE.tileX + 1, tileY: BOSS_TILE.tileY });
      face(room, "swinger", Direction.Right);
      attack(room, swinger, 0);
      assert.deepEqual(rosterOf(room, "boss"), ["swinger"], "a hit dealt enrols you");

      room["damagePlayer"]("victim", "boss", 1, 1000);
      assert.deepEqual(rosterOf(room, "boss"), ["swinger", "victim"], "so does a hit taken");
      assert.equal(victim.userData?.hp, PLAYER_MAX_HP - 1, "and the victim is only hurt, not dead");
    } finally {
      dispose(room);
    }
  });

  it("does not reset when one of two dies, and does when the second one does", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const a = join(room, "a");
      const b = join(room, "b");
      place(room, "a", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      place(room, "b", { tileX: BOSS_TILE.tileX + 1, tileY: BOSS_TILE.tileY });
      face(room, "a", Direction.Right);
      face(room, "b", Direction.Left);
      attack(room, a, 0);
      attack(room, b, 0);
      const runtime = runtimeOf(room, "boss");
      const damaged = FIXTURE_BOSS_HP - PLAYER_ATTACK_DAMAGE * 2;
      assert.equal(runtime.hp, damaged);

      kill(room, "a", "boss", 1000);
      assert.deepEqual(rosterOf(room, "boss"), ["b"], "the dead one left the roster");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "one death is not a wipe");
      room["tick"](1000 + WIPE_RESET_GRACE_MS * 2);
      assert.equal(runtime.hp, damaged, "and no amount of waiting resets it while somebody fights");

      kill(room, "b", "boss", 2000);
      assert.deepEqual(rosterOf(room, "boss"), [], "the group is gone");
      assert.equal(
        trackerOf(room, "boss").wipeResetAt,
        2000 + WIPE_RESET_GRACE_MS,
        "armed from the last death, with the design's 5s grace",
      );

      room["tick"](2000 + WIPE_RESET_GRACE_MS - 1);
      assert.equal(runtime.hp, damaged, "one millisecond early is not yet a wipe");
      room["tick"](2000 + WIPE_RESET_GRACE_MS);
      assert.equal(runtime.hp, FIXTURE_BOSS_HP, "exactly on the deadline it heals whole");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "and the timer disarms");
      assert.equal(runtime.state, "idle", "a full heal is not a respawn");
      assert.equal(room.state.monsters.has("boss"), true, "and never took it off the map");
    } finally {
      dispose(room);
    }
  });

  it("cancels the pending reset when anybody re-engages inside the grace window", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const a = join(room, "a");
      const rescuer = join(room, "rescuer");
      place(room, "a", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "a", Direction.Right);
      attack(room, a, 0);
      const runtime = runtimeOf(room, "boss");
      const damaged = runtime.hp;

      kill(room, "a", "boss", 1000);
      assert.equal(trackerOf(room, "boss").wipeResetAt, 1000 + WIPE_RESET_GRACE_MS);

      // A bystander who had not yet swung lands a hit two seconds in — the group continues.
      place(room, "rescuer", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "rescuer", Direction.Right);
      attack(room, rescuer, 0);
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "a new combatant disarms the timer");
      assert.deepEqual(rosterOf(room, "boss"), ["rescuer"]);

      room["tick"](1000 + WIPE_RESET_GRACE_MS + 1);
      assert.equal(
        runtime.hp,
        damaged - PLAYER_ATTACK_DAMAGE,
        "the old deadline must not fire behind the rescuer's back",
      );
    } finally {
      dispose(room);
    }
  });

  it("cancels it just as well when the boss is the one who re-engages", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const a = join(room, "a");
      const bystander = join(room, "bystander");
      place(room, "a", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "a", Direction.Right);
      attack(room, a, 0);
      const runtime = runtimeOf(room, "boss");
      const damaged = runtime.hp;
      kill(room, "a", "boss", 1000);

      place(room, "bystander", { tileX: BOSS_TILE.tileX + 1, tileY: BOSS_TILE.tileY });
      room["damagePlayer"]("bystander", "boss", 5, 1200);
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "being hit counts as fighting");

      room["tick"](1000 + WIPE_RESET_GRACE_MS + 1);
      assert.equal(runtime.hp, damaged);
    } finally {
      dispose(room);
    }
  });

  it("re-arms after a cancelled window when the group dies for real", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const a = join(room, "a");
      const b = join(room, "b");
      place(room, "a", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      place(room, "b", { tileX: BOSS_TILE.tileX + 1, tileY: BOSS_TILE.tileY });
      face(room, "a", Direction.Right);
      attack(room, a, 0);
      const runtime = runtimeOf(room, "boss");

      kill(room, "a", "boss", 1000);
      face(room, "b", Direction.Left);
      attack(room, b, 0);
      assert.equal(trackerOf(room, "boss").wipeResetAt, null);
      kill(room, "b", "boss", 3000);
      assert.equal(trackerOf(room, "boss").wipeResetAt, 3000 + WIPE_RESET_GRACE_MS);
      room["tick"](3000 + WIPE_RESET_GRACE_MS);
      assert.equal(runtime.hp, FIXTURE_BOSS_HP, "the second window is honoured");
    } finally {
      dispose(room);
    }
  });

  it("counts a wipe correctly when part of the group left the room instead of dying", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const leaver = join(room, "leaver");
      const stayer = join(room, "stayer");
      place(room, "leaver", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      place(room, "stayer", { tileX: BOSS_TILE.tileX + 1, tileY: BOSS_TILE.tileY });
      face(room, "leaver", Direction.Right);
      face(room, "stayer", Direction.Left);
      attack(room, leaver, 0);
      attack(room, stayer, 0);
      assert.deepEqual(rosterOf(room, "boss"), ["leaver", "stayer"]);

      room.onLeave(asRoomClient(leaver));
      assert.deepEqual(rosterOf(room, "boss"), ["stayer"], "a disconnect must not hold a seat");

      kill(room, "stayer", "boss", 1000);
      assert.equal(
        trackerOf(room, "boss").wipeResetAt,
        1000 + WIPE_RESET_GRACE_MS,
        "the last player actually present died, so this is a wipe",
      );
      room["tick"](1000 + WIPE_RESET_GRACE_MS);
      assert.equal(runtimeOf(room, "boss").hp, FIXTURE_BOSS_HP);
    } finally {
      dispose(room);
    }
  });

  it("clears a leaver from every boss in the room, and costs nothing where there are none", async () => {
    const second: TilePosition = { tileX: BOSS_TILE.tileX, tileY: BOSS_TILE.tileY + 6 };
    const room = await createRoom([bossAt("boss-a", BOSS_TILE), bossAt("boss-b", second)]);
    try {
      const fighter = join(room, "fighter");
      place(room, "fighter", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "fighter", Direction.Right);
      attack(room, fighter, 0);
      room["damagePlayer"]("fighter", "boss-b", 1, 500);
      assert.deepEqual(rosterOf(room, "boss-a"), ["fighter"]);
      assert.deepEqual(rosterOf(room, "boss-b"), ["fighter"]);

      room.onLeave(asRoomClient(fighter));
      assert.deepEqual(rosterOf(room, "boss-a"), []);
      assert.deepEqual(rosterOf(room, "boss-b"), []);
    } finally {
      dispose(room);
    }

    const bare = await createRoom([]);
    try {
      const passer = join(bare, "passer");
      bare.onLeave(asRoomClient(passer));
      assert.equal(bare.state.players.size, 0, "a monsterless room's leave path is untouched");
    } finally {
      dispose(bare);
    }
  });

  it("never resets a non-boss monster's health, however many of its attackers die", async () => {
    const room = await createRoom([squirrelAt("sq", BOSS_TILE)]);
    try {
      const a = join(room, "a");
      place(room, "a", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "a", Direction.Right);
      attack(room, a, 0);
      const runtime = runtimeOf(room, "sq");
      assert.equal(runtime.hp, 8 - PLAYER_ATTACK_DAMAGE);

      kill(room, "a", "sq", 1000);
      room["tick"](1000 + WIPE_RESET_GRACE_MS * 2);
      assert.equal(
        runtime.hp,
        8 - PLAYER_ATTACK_DAMAGE,
        "the wipe rule is the boss's alone (design §6.6)",
      );
    } finally {
      dispose(room);
    }
  });

  it("leaves the defeat record and the respawn timer alone when it heals", async () => {
    const store = new RecordingBossStateStore();
    const room = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      const a = join(room, "a");
      place(room, "a", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "a", Direction.Right);
      attack(room, a, 0);
      kill(room, "a", "boss", 1000);
      room["tick"](1000 + WIPE_RESET_GRACE_MS);
      await flush();

      assert.equal(runtimeOf(room, "boss").hp, FIXTURE_BOSS_HP);
      assert.equal(runtimeOf(room, "boss").respawnAt, 0, "a heal is not a death: no respawn was armed");
      assert.deepEqual(store.writes, [], "and nothing was written — this is not a defeat");
    } finally {
      dispose(room);
    }
  });

  it("does not resurrect a boss that is genuinely dead when a stale window fires", async () => {
    // A wipe armed just before the killing blow lands: the heal must not put a dead boss back on
    // the map behind `spawnMonster`'s back.
    const store = new RecordingBossStateStore();
    const room = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      const a = join(room, "a");
      const b = join(room, "b");
      place(room, "a", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "a", Direction.Right);
      attack(room, a, 0);
      kill(room, "a", "boss", 1000);
      assert.equal(trackerOf(room, "boss").wipeResetAt, 1000 + WIPE_RESET_GRACE_MS);

      swingUntil(room, b, "boss", 0);
      assert.equal(room.state.monsters.has("boss"), false, "b finished it off");
      room["tick"](1000 + WIPE_RESET_GRACE_MS);
      assert.equal(room.state.monsters.has("boss"), false, "the stale heal must not raise the dead");
      assert.equal(runtimeOf(room, "boss").state, "dead");
    } finally {
      dispose(room);
    }
  });

  it("holds the line with a full group: 19 deaths do not reset, the 20th does", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const group = Array.from({ length: 20 }, (_, index) => join(room, `p${index}`));
      for (const client of group) {
        place(room, client.sessionId, { tileX: BOSS_TILE.tileX + 1, tileY: BOSS_TILE.tileY });
        room["damagePlayer"](client.sessionId, "boss", 1, 100);
      }
      assert.equal(trackerOf(room, "boss").combatants.size, 20);
      const runtime = runtimeOf(room, "boss");
      runtime.hp = 1;

      for (const client of group.slice(0, 19)) {
        kill(room, client.sessionId, "boss", 1000);
        assert.equal(trackerOf(room, "boss").wipeResetAt, null, "somebody is still fighting");
      }
      const last = group.at(-1);
      assert.ok(last);
      kill(room, last.sessionId, "boss", 2000);
      assert.equal(trackerOf(room, "boss").wipeResetAt, 2000 + WIPE_RESET_GRACE_MS);
      room["tick"](2000 + WIPE_RESET_GRACE_MS);
      assert.equal(runtime.hp, FIXTURE_BOSS_HP, "a 20-person wipe resets exactly once");
    } finally {
      dispose(room);
    }
  });

  it("resets after a real tick-driven fight, not just a hand-driven one", async () => {
    // End to end through the simulation loop: the boss's own attacks are what kill the group, so
    // this exercises the same `damagePlayer` call site production uses.
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const a = join(room, "a");
      const b = join(room, "b");
      const runtime = runtimeOf(room, "boss");
      swingUntil(room, a, "boss", FIXTURE_BOSS_HP - PLAYER_ATTACK_DAMAGE);
      const damaged = runtime.hp;

      // a alone next to the boss: the tick's attack is the death.
      const monster = room.state.monsters.get("boss");
      assert.ok(monster);
      place(room, "a", { tileX: monster.tileX + 1, tileY: monster.tileY });
      place(room, "b", { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY });
      room["tick"](1000);
      assert.deepEqual(rosterOf(room, "boss"), [], "a died to the boss and left the roster");
      assert.equal(trackerOf(room, "boss").wipeResetAt, 1000 + WIPE_RESET_GRACE_MS);

      // b walks in during the grace window and dies too, which re-arms from *their* death.
      place(room, "b", { tileX: monster.tileX + 1, tileY: monster.tileY });
      room["tick"](1400);
      assert.equal(trackerOf(room, "boss").wipeResetAt, 1400 + WIPE_RESET_GRACE_MS);
      assert.equal(runtime.hp, damaged, "still nothing healed while the fight was live");

      room["tick"](1400 + WIPE_RESET_GRACE_MS);
      assert.equal(runtime.hp, FIXTURE_BOSS_HP);
    } finally {
      dispose(room);
    }
  });

  it("declares a wipe when the last combatant walks out instead of dying", async () => {
    // Coder flagged this as a judgement call (Pass S handoff) and team lead settled it: leaving is
    // judged exactly as dying is. The alternative made disconnecting strictly better than dying —
    // a lone attacker could whittle the boss down over several visits, never risking the reset
    // that a death costs, and take the 25% drop cheaply.
    //
    // `onLeave` reads the wall clock (it takes no `now`), so the deadline is asserted against a
    // bracket around it rather than a literal.
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const solo = join(room, "solo");
      const watcher = join(room, "watcher");
      place(room, "solo", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      place(room, "watcher", { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY });
      face(room, "solo", Direction.Right);
      attack(room, solo, 0);
      const damaged = runtimeOf(room, "boss").hp;

      const before = Date.now();
      room.onLeave(asRoomClient(solo));
      assert.deepEqual(rosterOf(room, "boss"), [], "the roster is empty");
      const armed = trackerOf(room, "boss").wipeResetAt;
      assert.ok(
        armed !== null &&
          armed >= before + WIPE_RESET_GRACE_MS &&
          armed <= Date.now() + WIPE_RESET_GRACE_MS,
        "the same 5s grace a death arms, counted from the departure",
      );

      room["tick"](armed - 1);
      assert.equal(runtimeOf(room, "boss").hp, damaged, "one millisecond early the damage stands");
      room["tick"](armed);
      assert.equal(runtimeOf(room, "boss").hp, FIXTURE_BOSS_HP, "and on the deadline it heals whole");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "the timer disarms as it does after a death");
      assert.equal(room.state.monsters.has("boss"), true, "a heal never takes it off the map");
      assert.equal(watcher.userData?.hp, PLAYER_MAX_HP, "the bystander was never part of this");
    } finally {
      dispose(room);
    }
  });

  it("declares a wipe when the only fighter dies to something other than the boss", async () => {
    // hunting-ground has 20 other monsters. Dying to a squirrel while fighting the boss is
    // ordinary play, so the roster is left by a death whoever dealt it — otherwise the corpse
    // stays enrolled and the wipe can never be declared again.
    const room = await createRoom([bossAt("boss", BOSS_TILE), squirrelAt("sq", SQUIRREL_TILE)]);
    try {
      const solo = join(room, "solo");
      place(room, "solo", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "solo", Direction.Right);
      attack(room, solo, 0);
      const damaged = runtimeOf(room, "boss").hp;
      assert.deepEqual(rosterOf(room, "boss"), ["solo"]);

      kill(room, "solo", "sq", 1000);
      assert.deepEqual(rosterOf(room, "boss"), [], "death is death, whoever dealt it");
      assert.equal(trackerOf(room, "boss").wipeResetAt, 1000 + WIPE_RESET_GRACE_MS);
      room["tick"](1000 + WIPE_RESET_GRACE_MS - 1);
      assert.equal(runtimeOf(room, "boss").hp, damaged, "not before the grace window is up");
      room["tick"](1000 + WIPE_RESET_GRACE_MS);
      assert.equal(runtimeOf(room, "boss").hp, FIXTURE_BOSS_HP, "everyone who was fighting is dead");
    } finally {
      dispose(room);
    }
  });

  it("applies the boss's real damage through the new helmet's reduction", async () => {
    // The drop this boss exists to give, read back through the path that consumes it: helmet and
    // armor combine multiplicatively (design §11.3 — 1-(1-0.2)(1-0.15) = 32%), so the real
    // boss's 18 lands as floor(18 * 0.68) = 12.
    const boss = MONSTER_TYPES.get(MonsterKind.Boss);
    assert.ok(boss);
    const room = await createRoom([bossAt("boss", BOSS_TILE)]);
    try {
      const wearer = join(room, "wearer");
      const session = room["clientsBySession"].get("wearer")?.userData;
      assert.ok(session);
      session.equippedItemKeys = { armor: "leather-armor", helmet: "golden-helmet" };
      place(room, "wearer", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });

      room["damagePlayer"]("wearer", "boss", boss.damage, 1000);
      assert.equal(boss.damage, 18, "the design's number, in case the table moves");
      assert.equal(
        session.hp,
        PLAYER_MAX_HP - 12,
        "32% combined reduction, floored — not summed to 35%",
      );
      assert.deepEqual(rosterOf(room, "boss"), ["wearer"], "and taking a hit still enrols them");
    } finally {
      dispose(room);
    }
  });

  it("gives a respawned boss a clean roster", async () => {
    // A respawn is a new monster ("it arrives whole, and it owes its drops to nobody",
    // spawnMonster). If the roster survived it, somebody still in the room who fought the
    // *previous* boss would keep blocking the new fight's wipe reset for good.
    const store = new RecordingBossStateStore();
    const room = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      const veteran = join(room, "veteran");
      const newcomer = join(room, "newcomer");
      swingUntil(room, veteran, "boss", 0);
      const runtime = runtimeOf(room, "boss");
      assert.equal(runtime.state, "dead");
      assert.deepEqual(rosterOf(room, "boss"), ["veteran"], "the killer was on the old roster");

      room["tick"](runtime.respawnAt);
      assert.equal(room.state.monsters.has("boss"), true, "six hours later it is back");
      assert.deepEqual(rosterOf(room, "boss"), [], "and it is nobody's fight yet");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "an empty roster here is not a wipe");

      // The newcomer fights it alone and dies: that is a wipe of the *current* group.
      place(room, "newcomer", { tileX: BOSS_TILE.tileX - 1, tileY: BOSS_TILE.tileY });
      face(room, "newcomer", Direction.Right);
      attack(room, newcomer, 0);
      kill(room, "newcomer", "boss", runtime.respawnAt + 1000);
      assert.equal(trackerOf(room, "boss").wipeResetAt, runtime.respawnAt + 1000 + WIPE_RESET_GRACE_MS);
    } finally {
      dispose(room);
    }
  });
});

// -- the boss's public surface: the loot-table panel ---------------------------------------------

describe("VERIFY the boss reaches the loot-table panel of both hunting rooms", () => {
  it("lists the boss with its Korean name and the golden helmet at 25%", () => {
    // `GET /api/loot-table/:roomName` is derived from the same tables, so the new kind and the new
    // item show up there without a line of route code — which is exactly why it is worth
    // asserting once: a `possession` drop is the first of its kind in this panel.
    for (const roomName of ["hunting-ground", "hunting-den"]) {
      const views = buildLootTableView(roomName);
      const boss = views.find((view) => view.kind === MonsterKind.Boss);
      assert.ok(boss, `${roomName}'s panel is missing the boss`);
      assert.equal(boss.name, "보스");
      assert.deepEqual(boss.drops, [
        { itemKey: "golden-helmet", name: "황금투구", icon: "golden-helmet", chancePercent: 25 },
      ]);
    }
  });

  it("puts the boss last, after the ordinary kinds of its room", () => {
    // MONSTER_TYPES declaration order is display order, and the boss row was appended — so the
    // panel reads squirrel/rabbit/deer first and the 6-hour event last, without a sort.
    for (const roomName of ["hunting-ground", "hunting-den"]) {
      const kinds = buildLootTableView(roomName).map((view) => view.kind);
      assert.equal(kinds.at(-1), MonsterKind.Boss, `${roomName}: ${kinds.join(", ")}`);
      assert.ok(kinds.length >= 2);
    }
  });

  it("leaves a room with no spawn rows without a panel at all", () => {
    assert.deepEqual(buildLootTableView("grand-plaza"), []);
  });
});
