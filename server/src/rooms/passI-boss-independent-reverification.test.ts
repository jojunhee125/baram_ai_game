import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Direction,
  MONSTER_TICK_MS,
  PLAYER_MAX_HP,
  type EquipmentSlot,
  type JoinOptions,
  type TilePosition,
} from "@zep-test/shared";
import type { BossStateStore } from "../db/bossStateStore";
import type { InventoryRow, InventoryStore } from "../db/inventoryStore";
import type { LandmarkIndex, RoomCreateOptions, SpawnArea } from "./contracts";
import { ROOM_DEFINITIONS } from "./definitions";
import { LANDMARK_DEFINITIONS } from "./landmarkDefinitions";
import { MetaverseRoom } from "./metaverseRoom";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";
import {
  BOSS_RESPAWN_MS,
  MONSTER_SPAWN_DEFINITIONS,
  MONSTER_TYPES,
  MonsterKind,
  type MonsterSpawnDefinition,
  type MonsterType,
} from "./monsterDefinitions";

/**
 * Independent re-verification of Phase I after Pass S's six fixes and Pass C landed together
 * (project convention: a second tester re-derives the result from the code rather than reading the
 * first pass's assertions). Written without consulting `passI-boss-verification.test.ts`'s cases —
 * overlap is confirmation, divergence is a finding.
 *
 * Two things this pass owns that the first could not:
 *   - the *combined* server+client state, which nobody had run as one thing before;
 *   - the `killMonster`-leaves-the-roster-populated judgement Pass S left open ("harmless"),
 *     re-derived here from behaviour rather than accepted.
 */

/** design §11.4. Not exported, so every assertion below derives it from observed behaviour. */
const WIPE_RESET_GRACE_MS = 5000;

/** design §7: a boss must stand this far from any tile a player can arrive on. */
const ARRIVAL_MARGIN_TILES = 6;

const OPEN_CENTRE: TilePosition = { tileX: 78, tileY: 70 };
const BOSS_TILE: TilePosition = { tileX: OPEN_CENTRE.tileX + 12, tileY: OPEN_CENTRE.tileY };
const SECOND_BOSS_TILE: TilePosition = { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY + 12 };
const SQUIRREL_TILE: TilePosition = { tileX: OPEN_CENTRE.tileX - 12, tileY: OPEN_CENTRE.tileY };

const FIXTURE_BOSS_HP = 20;

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
      loot: [{ itemKey: "golden-helmet", chance: 1, quantity: 1 }],
    },
  ],
  [
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
      loot: [],
    },
  ],
]);

// -- stores -------------------------------------------------------------------------------------

class SpyBossStateStore implements BossStateStore {
  readonly reads: string[] = [];
  readonly writes: { spawnId: string; defeatedAtMs: number }[] = [];
  private readonly defeated: Map<string, number>;

  constructor(seed: readonly (readonly [string, number])[] = []) {
    this.defeated = new Map(seed.map(([id, at]) => [id, at]));
  }

  getLastDefeatedAt(spawnId: string): Promise<number | null> {
    this.reads.push(spawnId);
    return Promise.resolve(this.defeated.get(spawnId) ?? null);
  }

  recordDefeat(spawnId: string, defeatedAtMs: number): Promise<void> {
    this.writes.push({ spawnId, defeatedAtMs });
    this.defeated.set(spawnId, defeatedAtMs);
    return Promise.resolve();
  }
}

/** Both halves reject, which is what a `PostgresBossStateStore` on a downed pool does. */
class DownBossStateStore implements BossStateStore {
  getLastDefeatedAt(): Promise<number | null> {
    return Promise.reject(new Error("connection terminated unexpectedly"));
  }

  recordDefeat(): Promise<void> {
    return Promise.reject(new Error("connection terminated unexpectedly"));
  }
}

class CountingInventoryStore implements InventoryStore {
  readonly granted: { ownerKey: string; itemKey: string }[] = [];

  list(): Promise<readonly InventoryRow[]> {
    return Promise.resolve([]);
  }

  add(): Promise<number | null> {
    return Promise.resolve(1);
  }

  grantOnce(ownerKey: string, itemKey: string): Promise<boolean> {
    this.granted.push({ ownerKey, itemKey });
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

/** Holds `list` past the caller's await, so two gated joins interleave across the capacity gate. */
class SlowGateInventoryStore implements InventoryStore {
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
  userData?: { lastAttackAt: number; hp: number; lastDamagedAt: number };
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

class ProbeRoom extends MetaverseRoom {
  fixtureSpawns: readonly MonsterSpawnDefinition[] = [];
  fixtureTypes: ReadonlyMap<MonsterKind, MonsterType> = FIXTURE_TYPES;
  fixtureLandmark: LandmarkIndex | null = null;
  randomValue = 0;
  readonly simulationStarts: number[] = [];

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

  override setSimulationInterval(_callback?: (deltaTime: number) => void, delay?: number): void {
    this.simulationStarts.push(delay ?? -1);
  }
}

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "reverify-boss",
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
  configure: (room: ProbeRoom) => void = () => {},
): Promise<ProbeRoom> {
  const room = new ProbeRoom();
  room.fixtureSpawns = spawns;
  configure(room);
  await room.onCreate({ ...ROOM_OPTIONS, ...overrides });
  return room;
}

async function createRealRoom(name: string, store?: BossStateStore): Promise<ProbeRoom> {
  const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `ROOM_DEFINITIONS has no "${name}" row`);
  const room = new ProbeRoom();
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

function join(room: MetaverseRoom, sessionId: string, ssoUserId: string | null = null): FakeClient {
  const client = fakeClient(sessionId, ssoUserId);
  void room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0 });
  return client;
}

function place(room: MetaverseRoom, sessionId: string, tile: TilePosition): void {
  const player = room.state.players.get(sessionId);
  assert.ok(player, `no player "${sessionId}"`);
  player.tileX = tile.tileX;
  player.tileY = tile.tileY;
  room["proximityIndex"].move(sessionId, tile);
  room["refreshViewFor"](sessionId);
  room["refreshMonsterViewFor"](sessionId);
}

function attack(room: MetaverseRoom, client: FakeClient): void {
  if (client.userData) {
    client.userData.lastAttackAt = 0;
  }
  room["handleAttack"](asRoomClient(client));
}

/** Puts `client` beside `monsterId`, facing it, and swings once. */
function swingAt(room: ProbeRoom, client: FakeClient, monsterId: string): void {
  const monster = room.state.monsters.get(monsterId);
  assert.ok(monster, `"${monsterId}" is not on the map`);
  place(room, client.sessionId, { tileX: monster.tileX - 1, tileY: monster.tileY });
  const player = room.state.players.get(client.sessionId);
  assert.ok(player);
  player.facing = Direction.Right;
  attack(room, client);
}

function killPlayer(room: MetaverseRoom, victim: string, byMonster: string, now: number): void {
  room["damagePlayer"](victim, byMonster, PLAYER_MAX_HP, now);
}

function runtimeOf(room: MetaverseRoom, monsterId: string) {
  const runtime = room["monsterRuntimes"].get(monsterId);
  assert.ok(runtime, `no runtime for "${monsterId}"`);
  return runtime;
}

function trackerOf(room: MetaverseRoom, monsterId: string) {
  const { combat } = runtimeOf(room, monsterId);
  assert.ok(combat, `"${monsterId}" carries no boss combat tracker`);
  return combat;
}

function roster(room: MetaverseRoom, monsterId: string): string[] {
  return [...trackerOf(room, monsterId).combatants].sort();
}

function tick(room: MetaverseRoom, now: number): void {
  room["tick"](now);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lets a fire-and-forget store call settle, so a rejection would reach the process. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

/** Runs `body` with the process's unhandled rejections captured instead of fatal. */
async function withRejectionsCaptured(body: () => Promise<void>): Promise<unknown[]> {
  const captured: unknown[] = [];
  const existing = process.listeners("unhandledRejection");
  for (const listener of existing) {
    process.off("unhandledRejection", listener);
  }
  const collect = (reason: unknown): void => {
    captured.push(reason);
  };
  process.on("unhandledRejection", collect);
  try {
    await body();
    await flush();
  } finally {
    process.off("unhandledRejection", collect);
    for (const listener of existing) {
      process.on("unhandledRejection", listener as never);
    }
  }
  return captured;
}

function chebyshev(a: TilePosition, b: TilePosition): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

/** Every tile a spawn area's spread square can draw. */
function spreadTiles(area: SpawnArea): TilePosition[] {
  const tiles: TilePosition[] = [];
  const radius = area.spreadRadiusInTiles;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      tiles.push({ tileX: area.tileX + dx, tileY: area.tileY + dy });
    }
  }
  return tiles;
}

// == A. the "harmless" judgement Pass S left open ===============================================

describe("REVERIFY A — a boss killed, then abandoned, stays killed", () => {
  it("heals a corpse's hp without resurrecting it, re-recording it, or re-paying its loot", async () => {
    const store = new SpyBossStateStore();
    const inventory = new CountingInventoryStore();
    const room = await createRoom([bossAt("boss", BOSS_TILE), squirrelAt("sq", SQUIRREL_TILE)], {
      bossStateStore: store,
      inventoryStore: inventory,
    });
    try {
      const killer = join(room, "killer", "owner-killer");
      // Five swings at 4 damage each brings FIXTURE_BOSS_HP down to exactly 0.
      for (let swing = 0; swing < FIXTURE_BOSS_HP / 4; swing += 1) {
        swingAt(room, killer, "boss");
      }
      const runtime = runtimeOf(room, "boss");
      assert.equal(runtime.state, "dead", "the boss died to those swings");
      assert.equal(room.state.monsters.has("boss"), false);
      const respawnAt = runtime.respawnAt;
      assert.equal(store.writes.length, 1, "one defeat recorded");
      await flush();
      const grantsAfterKill = inventory.granted.length;
      assert.equal(grantsAfterKill, 1, "the 100%-chance drop paid out once");

      // The roster still holds the killer: `killMonster` deliberately does not clear it.
      assert.deepEqual(roster(room, "boss"), ["killer"], "a corpse keeps its roster");

      const leaveAt = respawnAt - BOSS_RESPAWN_MS + 10_000;
      room.onLeave(asRoomClient(killer));
      const tracker = trackerOf(room, "boss");
      assert.deepEqual([...tracker.combatants], [], "leaving emptied it");
      assert.notEqual(tracker.wipeResetAt, null, "and armed the wipe timer on a corpse");

      // The grace elapses. This is the state Pass S called harmless.
      tick(room, (tracker.wipeResetAt as number) + 1);
      assert.equal(runtime.hp, FIXTURE_BOSS_HP, "the corpse's hp was restored");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "and the timer disarmed");

      // Harmless requires all four of these.
      assert.equal(runtime.state, "dead", "still dead — a heal is not a respawn");
      assert.equal(room.state.monsters.has("boss"), false, "still off the map");
      assert.equal(runtime.respawnAt, respawnAt, "respawn deadline untouched by the heal");
      assert.equal(store.writes.length, 1, "no second defeat record");

      // And it must not be attackable while healed-but-dead: that is the double-payout path.
      const scavenger = join(room, "scavenger", "owner-scavenger");
      place(room, "scavenger", BOSS_TILE);
      const before = scavenger.sent.length;
      attack(room, scavenger);
      await flush();
      assert.equal(scavenger.sent.length, before, "a swing at a corpse lands on nothing");
      assert.equal(store.writes.length, 1, "and records nothing");
      assert.equal(inventory.granted.length, grantsAfterKill, "and pays nothing");

      // The in-memory respawn still lands exactly where the kill put it.
      tick(room, respawnAt - 1);
      assert.equal(room.state.monsters.has("boss"), false, "one ms early is still dead");
      tick(room, respawnAt);
      assert.equal(room.state.monsters.has("boss"), true, "and it arrives on the deadline");
      assert.equal(runtime.hp, FIXTURE_BOSS_HP);
      assert.deepEqual(roster(room, "boss"), [], "the new fight starts with nobody enrolled");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null);
      assert.equal(store.writes.length, 1, "and the whole cycle recorded exactly one defeat");
    } finally {
      dispose(room);
    }
  });

  it("tells no client about the corpse's heal", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new SpyBossStateStore(),
    });
    try {
      const killer = join(room, "killer");
      for (let swing = 0; swing < FIXTURE_BOSS_HP / 4; swing += 1) {
        swingAt(room, killer, "boss");
      }
      const watcher = join(room, "watcher");
      place(room, "watcher", BOSS_TILE);
      room.onLeave(asRoomClient(killer));
      const armedAt = trackerOf(room, "boss").wipeResetAt;
      assert.notEqual(armedAt, null);
      const before = watcher.sent.length;
      tick(room, (armedAt as number) + 1);
      assert.equal(
        watcher.sent.length,
        before,
        "a corpse's hp is server-side only — nothing on the wire says it healed",
      );
    } finally {
      dispose(room);
    }
  });
});

// == B. the real tables' geometry ================================================================

describe("REVERIFY B — each boss stands clear of the tiles players arrive on", () => {
  /** Every tile a player can appear on in `room`, by the route that puts them there. */
  function arrivalTiles(roomName: string): { label: string; tile: TilePosition }[] {
    const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === roomName);
    assert.ok(definition);
    const tiles: { label: string; tile: TilePosition }[] = [];
    for (const tile of spreadTiles(definition.spawn)) {
      tiles.push({ label: "room spawn spread", tile });
    }
    // `metaverseRoom.ts:273` — home is the spawn's centre with the spread dropped, and it is where
    // death warps a player to.
    tiles.push({
      label: "home (death warp target)",
      tile: { tileX: definition.spawn.tileX, tileY: definition.spawn.tileY },
    });
    for (const portal of PORTAL_DEFINITIONS) {
      if (portal.to.room !== roomName) {
        continue;
      }
      for (const tile of spreadTiles(portal.to.arrival)) {
        tiles.push({ label: `portal "${portal.id}" arrival`, tile });
      }
    }
    for (const landmark of LANDMARK_DEFINITIONS) {
      if (landmark.room !== roomName || landmark.tile === undefined) {
        continue;
      }
      for (const tile of spreadTiles(landmark.tile)) {
        tiles.push({ label: `landmark "${landmark.id}"`, tile });
      }
    }
    return tiles;
  }

  for (const spawn of MONSTER_SPAWN_DEFINITIONS.filter((row) => row.persistentRespawn === true)) {
    it(`${spawn.id}: no arrival tile sits inside its wander box`, () => {
      const offenders = arrivalTiles(spawn.room)
        .filter(({ tile }) => chebyshev(spawn.at, tile) <= spawn.wanderRadiusTiles)
        .map(({ label, tile }) => `${label} (${tile.tileX},${tile.tileY})`);
      assert.deepEqual(
        offenders,
        [],
        `${spawn.id} at (${spawn.at.tileX},${spawn.at.tileY}) radius ${spawn.wanderRadiusTiles} ` +
          `can stand on: ${offenders.join(", ")}`,
      );
    });

    it(`${spawn.id}: every arrival tile clears the design §7 ${ARRIVAL_MARGIN_TILES}-tile margin`, () => {
      const offenders = arrivalTiles(spawn.room)
        .map(({ label, tile }) => ({ label, tile, distance: chebyshev(spawn.at, tile) }))
        .filter(({ distance }) => distance < ARRIVAL_MARGIN_TILES)
        .map(({ label, tile, distance }) => `${label} (${tile.tileX},${tile.tileY}) at ${distance}`);
      assert.deepEqual(
        offenders,
        [],
        `${spawn.id} is closer than ${ARRIVAL_MARGIN_TILES} tiles to: ${offenders.join(", ")}`,
      );
    });

    it(`${spawn.id}: a player standing at home is outside its aggro reach`, () => {
      const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === spawn.room);
      assert.ok(definition);
      const type = MONSTER_TYPES.get(spawn.kind);
      assert.ok(type);
      const home: TilePosition = {
        tileX: definition.spawn.tileX,
        tileY: definition.spawn.tileY,
      };
      // The nearest the boss can legally get without a target: the corner of its wander box
      // closest to home. From there its aggro radius has to still fall short.
      const reach = spawn.wanderRadiusTiles + type.aggroRadiusTiles;
      assert.ok(
        chebyshev(spawn.at, home) > reach,
        `${spawn.id} wanders to within ${type.aggroRadiusTiles} tiles of home ` +
          `(${home.tileX},${home.tileY}): distance ${chebyshev(spawn.at, home)}, reach ${reach}. ` +
          `A player warped home by death is re-aggroed on arrival.`,
      );
    });
  }
});

// == C. what that geometry does to the wipe rule =================================================

describe("REVERIFY C — the wipe rule survives the death it was armed by", () => {
  it("cannot re-aggro the player it just killed, so the wipe it armed runs to completion", async () => {
    const room = await createRealRoom("hunting-den", new SpyBossStateStore());
    try {
      const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === "hunting-den");
      assert.ok(definition);
      const home: TilePosition = { tileX: definition.spawn.tileX, tileY: definition.spawn.tileY };
      const bossSpawn = MONSTER_SPAWN_DEFINITIONS.find((row) => row.id === "hd-boss-01");
      assert.ok(bossSpawn);

      const boss = room.state.monsters.get("hd-boss-01");
      assert.ok(boss, "hd-boss-01 starts alive");
      // The edge of its own wander box nearest home — the closest tile it reaches by ordinary
      // wandering, with no player having dragged it anywhere.
      const edge: TilePosition = {
        tileX: bossSpawn.at.tileX,
        tileY: bossSpawn.at.tileY + bossSpawn.wanderRadiusTiles,
      };
      boss.tileX = edge.tileX;
      boss.tileY = edge.tileY;
      room["monsterIndex"].move("hd-boss-01", edge);

      const solo = join(room, "solo");
      place(room, "solo", home);
      assert.ok(
        chebyshev(edge, home) > (MONSTER_TYPES.get(MonsterKind.Boss)?.aggroRadiusTiles ?? 0),
        `the boss's own wander edge (${edge.tileX},${edge.tileY}) still reaches home ` +
          `(${home.tileX},${home.tileY}): a boss that can stand within aggro of the death-warp ` +
          `tile cancels every wipe it declares (the (31,20) placement this replaced)`,
      );

      const runtime = runtimeOf(room, "hd-boss-01");
      // Solo player whittles it down, then dies. This is the exact sequence §6.6 exists to punish.
      runtime.hp = 500;
      runtime.combat!.combatants.add("solo");
      const deathAt = 1_000_000;
      killPlayer(room, "solo", "hd-boss-01", deathAt);
      const tracker = trackerOf(room, "hd-boss-01");
      assert.deepEqual([...tracker.combatants], [], "the death emptied the roster");
      assert.equal(tracker.wipeResetAt, deathAt + WIPE_RESET_GRACE_MS, "and armed the wipe");

      const player = room.state.players.get("solo");
      assert.ok(player);
      assert.deepEqual({ tileX: player.tileX, tileY: player.tileY }, home, "death warps to home");

      // Ticks inside the grace window, with the boss off cooldown and standing as close to the
      // corpse's respawn point as its leash-free wandering can put it.
      runtime.nextAttackAt = 0;
      tick(room, deathAt + 1400);
      assert.equal(
        trackerOf(room, "hd-boss-01").wipeResetAt,
        deathAt + WIPE_RESET_GRACE_MS,
        "the boss cannot reach a player standing at home, so the pending wipe stands",
      );
      assert.equal(runtime.hp, 500, "and the grace has not elapsed yet");

      tick(room, deathAt + WIPE_RESET_GRACE_MS);
      assert.equal(
        runtime.hp,
        runtime.type.maxHp,
        "on the deadline the boss is whole again — the solo player's progress is forfeit, " +
          "which is the whole point of §6.6",
      );
      assert.equal(trackerOf(room, "hd-boss-01").wipeResetAt, null, "and the timer disarmed");
    } finally {
      dispose(room);
    }
  });
});

// == D. the six fixes, re-derived ================================================================

describe("REVERIFY D1 — a failing defeat write does not take the process down", () => {
  it("logs and continues when recordDefeat rejects", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new DownBossStateStore(),
    });
    try {
      const captured = await withRejectionsCaptured(async () => {
        const killer = join(room, "killer");
        await flush();
        for (let swing = 0; swing < FIXTURE_BOSS_HP / 4; swing += 1) {
          swingAt(room, killer, "boss");
        }
      });
      assert.deepEqual(captured, [], "the fire-and-forget write's rejection was handled");
      assert.equal(runtimeOf(room, "boss").state, "dead", "and the kill still happened");
    } finally {
      dispose(room);
    }
  });
});

describe("REVERIFY D2 — a failing start-state read costs one row, not the room", () => {
  it("builds hunting-ground with every other monster and the boss alive", async () => {
    const room = await createRealRoom("hunting-ground", new DownBossStateStore());
    try {
      const rows = MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === "hunting-ground");
      assert.equal(
        room.state.monsters.size,
        rows.length,
        "every row is on the map, boss included — a down store means 'start alive'",
      );
      assert.equal(runtimeOf(room, "hg-boss-01").state, "idle");
      assert.equal(room.simulationStarts.length, 1, "and the tick loop started");
      assert.equal(room.simulationStarts[0], MONSTER_TICK_MS);
    } finally {
      dispose(room);
    }
  });

  it("still starts the tick loop when every boss row starts dead", async () => {
    const store = new SpyBossStateStore([["boss", Date.now() - 60_000]]);
    const room = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      assert.equal(room.state.monsters.size, 0, "the only row started dead");
      assert.equal(
        room.simulationStarts.length,
        1,
        "the gate reads registered rows, not living ones (design §6.4) — otherwise the boss " +
          "would never respawn in this instance",
      );
      assert.equal(room["hasMonsters"], true);
    } finally {
      dispose(room);
    }
  });
});

describe("REVERIFY D3 — the real cap survives the gated-landmark await", () => {
  it("admits exactly realCapacity when every join races through the item check", async () => {
    const capacity = 3;
    const room = await createRoom([], {
      roomType: "hunting-den",
      mapKey: "hunting-den",
      maxClients: 500,
      realCapacity: capacity,
      spawn: { tileX: 31, tileY: 24, spreadRadiusInTiles: 1 },
      inventoryStore: new SlowGateInventoryStore(20),
    });
    try {
      const attempts = 10;
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, (_unused, index) => {
          const client = fakeClient(`racer-${index}`, `owner-${index}`);
          return room.onJoin(asRoomClient(client), {
            nickname: `racer-${index}`,
            avatarSkin: 0,
            arriveAtLandmark: "landmark-hunting-den",
          } satisfies JoinOptions);
        }),
      );
      const admitted = results.filter((result) => result.status === "fulfilled").length;
      assert.equal(admitted, capacity, `${admitted} of ${attempts} concurrent gated joins got in`);
      assert.equal(room.state.players.size, capacity, "and the room holds exactly that many");
      for (const result of results) {
        if (result.status === "rejected") {
          assert.match(String(result.reason), /is full/);
        }
      }
    } finally {
      dispose(room);
    }
  });

  it("falls back to maxClients in a room that declares no realCapacity", async () => {
    const room = await createRoom([], { maxClients: 2 });
    try {
      join(room, "a");
      join(room, "b");
      await assert.rejects(
        room.onJoin(asRoomClient(fakeClient("c")), { nickname: "c", avatarSkin: 0 }),
        /is full/,
      );
    } finally {
      dispose(room);
    }
  });
});

describe("REVERIFY D4 — a death anywhere leaves every boss fight", () => {
  it("clears the boss roster when the killer was a squirrel", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE), squirrelAt("sq", SQUIRREL_TILE)], {
      bossStateStore: new SpyBossStateStore(),
    });
    try {
      join(room, "hunter");
      runtimeOf(room, "boss").combat!.combatants.add("hunter");
      assert.equal(runtimeOf(room, "sq").combat, null, "a squirrel carries no tracker");

      killPlayer(room, "hunter", "sq", 500_000);
      assert.deepEqual(roster(room, "boss"), [], "the boss's roster let the corpse go");
      assert.equal(
        trackerOf(room, "boss").wipeResetAt,
        500_000 + WIPE_RESET_GRACE_MS,
        "and declared the wipe, since nobody else was enrolled",
      );
    } finally {
      dispose(room);
    }
  });

  it("clears the roster of every boss in the room at once", async () => {
    const room = await createRoom(
      [bossAt("boss-a", BOSS_TILE), bossAt("boss-b", SECOND_BOSS_TILE)],
      { bossStateStore: new SpyBossStateStore() },
    );
    try {
      join(room, "hunter");
      join(room, "other");
      for (const id of ["boss-a", "boss-b"]) {
        runtimeOf(room, id).combat!.combatants.add("hunter");
      }
      runtimeOf(room, "boss-b").combat!.combatants.add("other");

      killPlayer(room, "hunter", "boss-a", 700_000);
      assert.deepEqual(roster(room, "boss-a"), [], "left boss-a");
      assert.deepEqual(roster(room, "boss-b"), ["other"], "and boss-b, which still has a fighter");
      assert.equal(trackerOf(room, "boss-a").wipeResetAt, 700_000 + WIPE_RESET_GRACE_MS);
      assert.equal(
        trackerOf(room, "boss-b").wipeResetAt,
        null,
        "one survivor is enough to keep boss-b's fight alive",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("REVERIFY D5/D6 — disconnecting declares a wipe on the same terms as dying", () => {
  it("restores full hp about WIPE_RESET_GRACE_MS after the last fighter drops connection", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new SpyBossStateStore(),
    });
    try {
      const solo = join(room, "solo");
      swingAt(room, solo, "boss");
      const runtime = runtimeOf(room, "boss");
      assert.ok(runtime.hp < FIXTURE_BOSS_HP, "the boss is hurt");
      assert.deepEqual(roster(room, "boss"), ["solo"], "and a swing enrolled the swinger");
      const hurtHp = runtime.hp;

      room.onLeave(asRoomClient(solo));
      const armedAt = trackerOf(room, "boss").wipeResetAt;
      assert.notEqual(armedAt, null, "a disconnect arms the wipe (design §6.6, 2026-09-09)");

      tick(room, (armedAt as number) - 1);
      assert.equal(runtime.hp, hurtHp, "one ms early it is still hurt");
      tick(room, armedAt as number);
      assert.equal(
        runtime.hp,
        FIXTURE_BOSS_HP,
        "and on the deadline exactly it is whole again — this is Pass C's observed 5-second reset",
      );
      assert.equal(trackerOf(room, "boss").wipeResetAt, null);
      assert.equal(runtime.state, "idle", "and it is still the same living boss, not a respawn");
    } finally {
      dispose(room);
    }
  });

  it("cancels a pending wipe when anybody re-engages inside the grace window", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new SpyBossStateStore(),
    });
    try {
      const first = join(room, "first");
      swingAt(room, first, "boss");
      const runtime = runtimeOf(room, "boss");
      const hurtHp = runtime.hp;
      room.onLeave(asRoomClient(first));
      const armedAt = trackerOf(room, "boss").wipeResetAt as number;
      assert.notEqual(armedAt, null);

      const second = join(room, "second");
      swingAt(room, second, "boss");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "a new swing cancels the wipe");
      tick(room, armedAt + 60_000);
      assert.ok(runtime.hp < hurtHp, "and the fight's progress is kept, not undone");
    } finally {
      dispose(room);
    }
  });

  it("counts being hit as re-engagement, not just swinging", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new SpyBossStateStore(),
    });
    try {
      const first = join(room, "first");
      swingAt(room, first, "boss");
      room.onLeave(asRoomClient(first));
      assert.notEqual(trackerOf(room, "boss").wipeResetAt, null);

      join(room, "bystander");
      place(room, "bystander", BOSS_TILE);
      room["damagePlayer"]("bystander", "boss", 1, 900_000);
      assert.equal(
        trackerOf(room, "boss").wipeResetAt,
        null,
        "the boss swinging at somebody means the fight is on again",
      );
      assert.deepEqual(roster(room, "boss"), ["bystander"]);
    } finally {
      dispose(room);
    }
  });

  it("does not push a pending wipe out of reach when a non-combatant leaves", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new SpyBossStateStore(),
    });
    try {
      const fighter = join(room, "fighter");
      swingAt(room, fighter, "boss");
      room.onLeave(asRoomClient(fighter));
      const armedAt = trackerOf(room, "boss").wipeResetAt;
      assert.notEqual(armedAt, null);

      for (let index = 0; index < 5; index += 1) {
        const passer = join(room, `passer-${index}`);
        room.onLeave(asRoomClient(passer));
      }
      assert.equal(
        trackerOf(room, "boss").wipeResetAt,
        armedAt,
        "a passer-by leaving must not re-arm the timer — that would defer the wipe forever",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("REVERIFY D7 — a respawned boss inherits nothing from the fight that killed it", () => {
  it("clears the roster and does not read an empty roster as a wipe", async () => {
    const store = new SpyBossStateStore();
    const room = await createRoom([bossAt("boss", BOSS_TILE)], { bossStateStore: store });
    try {
      const killer = join(room, "killer");
      for (let swing = 0; swing < FIXTURE_BOSS_HP / 4; swing += 1) {
        swingAt(room, killer, "boss");
      }
      const runtime = runtimeOf(room, "boss");
      assert.deepEqual(roster(room, "boss"), ["killer"], "the corpse still holds its killer");

      tick(room, runtime.respawnAt);
      assert.equal(room.state.monsters.has("boss"), true);
      assert.deepEqual(roster(room, "boss"), [], "the new boss's roster is empty");
      assert.equal(
        trackerOf(room, "boss").wipeResetAt,
        null,
        "and empty reads as 'no fight yet', not as 'the group was wiped'",
      );
      assert.equal(runtime.hp, FIXTURE_BOSS_HP);
      assert.equal(runtime.lastHitBy, null, "and it owes its drops to nobody");

      // A wipe declared on the *new* fight still works.
      swingAt(room, killer, "boss");
      assert.deepEqual(roster(room, "boss"), ["killer"]);
      killPlayer(room, "killer", "boss", runtime.respawnAt + 1000);
      assert.equal(
        trackerOf(room, "boss").wipeResetAt,
        runtime.respawnAt + 1000 + WIPE_RESET_GRACE_MS,
      );
    } finally {
      dispose(room);
    }
  });
});

// == E. boundaries, state combinations, volume ===================================================

describe("REVERIFY E — the wipe rule under boundary and volume", () => {
  it("declares the wipe only on the last of many sequential deaths", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new SpyBossStateStore(),
    });
    try {
      const party = 20;
      const runtime = runtimeOf(room, "boss");
      for (let index = 0; index < party; index += 1) {
        join(room, `p-${index}`);
        runtime.combat!.combatants.add(`p-${index}`);
      }
      runtime.hp = 1;

      for (let index = 0; index < party - 1; index += 1) {
        killPlayer(room, `p-${index}`, "boss", 1_000_000 + index);
        assert.equal(
          trackerOf(room, "boss").wipeResetAt,
          null,
          `death ${index + 1} of ${party} must not declare a wipe — ${party - index - 1} still fighting`,
        );
      }
      killPlayer(room, `p-${party - 1}`, "boss", 1_000_100);
      assert.equal(
        trackerOf(room, "boss").wipeResetAt,
        1_000_100 + WIPE_RESET_GRACE_MS,
        "the last death declares it",
      );
      tick(room, 1_000_100 + WIPE_RESET_GRACE_MS);
      assert.equal(runtime.hp, FIXTURE_BOSS_HP);
    } finally {
      dispose(room);
    }
  });

  it("survives a session leaving twice and a session that never fought", async () => {
    const room = await createRoom([bossAt("boss", BOSS_TILE)], {
      bossStateStore: new SpyBossStateStore(),
    });
    try {
      const fighter = join(room, "fighter");
      swingAt(room, fighter, "boss");
      room.onLeave(asRoomClient(fighter));
      const armedAt = trackerOf(room, "boss").wipeResetAt;
      room.onLeave(asRoomClient(fighter));
      assert.equal(trackerOf(room, "boss").wipeResetAt, armedAt, "a double leave changes nothing");

      // Same session id rejoining mid-grace, as a Colyseus reconnect does.
      const again = join(room, "fighter");
      swingAt(room, again, "boss");
      assert.equal(trackerOf(room, "boss").wipeResetAt, null, "and a reconnect cancels the wipe");
      assert.deepEqual(roster(room, "boss"), ["fighter"]);
    } finally {
      dispose(room);
    }
  });

  it("never puts a tracker on a non-boss row, so the tick skips it entirely", async () => {
    const room = await createRealRoom("hunting-ground");
    try {
      for (const [id, runtime] of room["monsterRuntimes"]) {
        const shouldTrack = runtime.type.isBoss === true;
        assert.equal(
          runtime.combat !== null,
          shouldTrack,
          `"${id}" (${runtime.definition.kind}) tracker presence disagrees with isBoss`,
        );
      }
      const bossRows = [...room["monsterRuntimes"].values()].filter(
        (runtime) => runtime.combat !== null,
      );
      assert.equal(bossRows.length, 1, "hunting-ground holds exactly one boss row");
    } finally {
      dispose(room);
    }
  });

  it("keeps both zones' bosses on independent timers in independent rooms", async () => {
    const shared = new SpyBossStateStore();
    const ground = await createRealRoom("hunting-ground", shared);
    const den = await createRealRoom("hunting-den", shared);
    try {
      assert.deepEqual(
        shared.reads.sort(),
        ["hd-boss-01", "hg-boss-01"],
        "each room read only its own boss row",
      );
      const groundRuntime = runtimeOf(ground, "hg-boss-01");
      groundRuntime.hp = 1;
      const killer = join(ground, "killer");
      swingAt(ground, killer, "hg-boss-01");
      await flush();
      assert.deepEqual(
        shared.writes.map((write) => write.spawnId),
        ["hg-boss-01"],
        "killing one zone's boss records only that zone's row",
      );
      assert.equal(
        runtimeOf(den, "hd-boss-01").state,
        "idle",
        "and the other zone's boss is untouched",
      );
    } finally {
      dispose(ground);
      dispose(den);
    }
  });
});
