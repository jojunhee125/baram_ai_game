import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATTACK_PER_LEVEL,
  COMBAT_EXIT_MS,
  Direction,
  HP_PER_LEVEL,
  LEVEL_CAP,
  MONSTER_TICK_MS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_MAX_HP,
  ServerMessage,
  cumulativeExpForLevel,
  expToNextLevel,
  levelForExp,
  remainingExpToNextLevel,
  type ExpGranted,
  type JoinOptions,
  type PlayerHit,
  type TilePosition,
} from "@zep-test/shared";
import { CachedProgressStore } from "../db/progressCache";
import { InMemoryProgressStore, type ProgressStore } from "../db/progressStore";
import type { CollisionMap, ProximityIndex, RoomCreateOptions } from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";
import { MonsterKind, type MonsterSpawnDefinition, type MonsterType } from "./monsterDefinitions";

/**
 * Phase W-1 (`docs/design-phase-w-level-system.md`, `docs/decisions.md` 2026-09-11 "Phase W·X 구현
 * 착수 승인"): the server-only half of the level/EXP system — the shared curve (§11), the level-1
 * anchor (§4.2), grantExp/level-up (§6), boss/last-hit attribution (§11-5), the death penalty
 * (§11.0) and its admin exemption, the recovery-fraction conversion (§4.4). Phase W-2a
 * (`docs/design-phase-w2-level-client.md` §1, `docs/decisions.md` 2026-09-11 "레벨은 grand-plaza를
 * 포함한 모든 room에서 실제 값이 보여야 한다") replaced the grand-plaza *zero-query* invariant with a
 * *once-per-account, ever* one via `CachedProgressStore` — see the "grand-plaza shows real levels"
 * describe block below.
 *
 * Harness modeled on `passE-combat-verification.test.ts` (hand-driven room, no live timer, no
 * `@colyseus/testing` socket) — every case here needs an exact `now` or an exact call count.
 */

describe("VERIFY the shared level/EXP curve", () => {
  it("costs 0 cumulative EXP to be level 1", () => {
    assert.equal(cumulativeExpForLevel(1), 0);
    assert.equal(levelForExp(0), 1);
  });

  it("matches the design's formula exactly at L=1 and at the L=29 -> 30 boundary", () => {
    assert.equal(expToNextLevel(1), Math.round(10 * 1 ** 1.7));
    assert.equal(expToNextLevel(29), Math.round(10 * 29 ** 1.7));
    const thresholdFor30 = cumulativeExpForLevel(30);
    assert.equal(levelForExp(thresholdFor30 - 1), 29, "one short of the threshold is still 29");
    assert.equal(levelForExp(thresholdFor30), 30, "exactly on the threshold is 30");
  });

  it("never exceeds LEVEL_CAP, however much EXP is added past it", () => {
    const cap = cumulativeExpForLevel(LEVEL_CAP);
    assert.equal(levelForExp(cap), LEVEL_CAP);
    assert.equal(levelForExp(cap + 1_000_000), LEVEL_CAP, "no overflow past the cap");
    assert.equal(remainingExpToNextLevel(cap), null, "nothing left to grind once capped");
    assert.equal(remainingExpToNextLevel(cap + 1_000_000), null);
  });

  it("reports the exact remaining EXP to the next level, not just a level number", () => {
    assert.equal(remainingExpToNextLevel(0), cumulativeExpForLevel(2), "level 1, nothing granted yet");
    const threshold2 = cumulativeExpForLevel(2);
    assert.equal(remainingExpToNextLevel(threshold2), cumulativeExpForLevel(3) - threshold2);
  });

  it("sums to roughly 34,000 cumulative EXP by the cap (design §11)", () => {
    const total = cumulativeExpForLevel(LEVEL_CAP);
    assert.ok(total > 30_000 && total < 38_000, `expected ~34,000, got ${total}`);
  });
});

// -- room harness ---------------------------------------------------------------------------------

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
    totalExp: number;
    ownerKey: string | null;
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

/** Squirrel: one hit (4 = PLAYER_ATTACK_DAMAGE) kills it. Rabbit: two hits. Deer: one hit, big EXP. */
const FIXTURE_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
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
      respawnDelayMs: 1_000_000,
      expReward: 4,
      loot: [],
    },
  ],
  [
    MonsterKind.Rabbit,
    {
      kind: MonsterKind.Rabbit,
      maxHp: PLAYER_ATTACK_DAMAGE * 2,
      damage: 0,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 0,
      leashRadiusTiles: 0,
      respawnDelayMs: 1_000_000,
      expReward: 7,
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
      respawnDelayMs: 1_000_000,
      // cumulativeExpForLevel(2) === expToNextLevel(1) — one kill levels a fresh account to 2.
      expReward: expToNextLevel(1),
      loot: [],
    },
  ],
]);

function squirrelAt(id: string, at: TilePosition): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind: MonsterKind.Squirrel, at, wanderRadiusTiles: 0 };
}

function rabbitAt(id: string, at: TilePosition): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind: MonsterKind.Rabbit, at, wanderRadiusTiles: 0 };
}

function deerAt(id: string, at: TilePosition): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind: MonsterKind.Deer, at, wanderRadiusTiles: 0 };
}

class VerifyRoom extends MetaverseRoom {
  fixtureSpawns: readonly MonsterSpawnDefinition[] = [];

  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return this.fixtureSpawns;
  }

  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return FIXTURE_TYPES;
  }

  override setSimulationInterval(): void {
    // A live timer would mutate state mid-assertion; every test drives tick/damagePlayer itself.
  }
}

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "verify-level",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
};

async function createRoom(
  spawns: readonly MonsterSpawnDefinition[],
  overrides: Partial<RoomCreateOptions> = {},
): Promise<VerifyRoom> {
  const room = new VerifyRoom();
  room.fixtureSpawns = spawns;
  await room.onCreate({ ...ROOM_OPTIONS, ...overrides });
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

function kill(room: MetaverseRoom, victim: string, damage: number, now: number): void {
  room["damagePlayer"](victim, "any-monster", damage, now);
}

/** Lets a fire-and-forget store call settle before the assertion reads what it sent. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

class CountingProgressStore implements ProgressStore {
  calls = 0;
  private readonly inner = new InMemoryProgressStore();

  getExp(ownerKey: string): Promise<number | null> {
    this.calls += 1;
    return this.inner.getExp(ownerKey);
  }

  grantExp(ownerKey: string, amount: number): Promise<number> {
    this.calls += 1;
    return this.inner.grantExp(ownerKey, amount);
  }

  applyDeathPenalty(ownerKey: string, floor: number): Promise<number | null> {
    this.calls += 1;
    return this.inner.applyDeathPenalty(ownerKey, floor);
  }
}

// -- anchor ----------------------------------------------------------------------------------------

it("hydrates saved high-level EXP with full level-scaled HP", async () => {
  const store = new InMemoryProgressStore();
  await store.grantExp("owner-hp", cumulativeExpForLevel(LEVEL_CAP));
  const room = await createRoom([], { progressStore: new CachedProgressStore(store) });
  try {
    const visitor = join(room, "visitor-hp", undefined, "owner-hp");
    await flush();
    assert.equal(room.state.players.get("visitor-hp")?.level, LEVEL_CAP);
    assert.equal(visitor.userData?.hp, PLAYER_MAX_HP + (LEVEL_CAP - 1) * HP_PER_LEVEL);
  } finally {
    dispose(room);
  }
});

it("preserves damage taken while saved EXP hydration is pending", async () => {
  const store = new InMemoryProgressStore();
  let resolveRead!: (exp: number) => void;
  const pendingExp = new Promise<number>((resolve) => { resolveRead = resolve; });
  store.getExp = () => pendingExp;
  const room = await createRoom([], { progressStore: store });
  try {
    const visitor = join(room, "visitor-delayed", undefined, "owner-delayed");
    place(room, "visitor-delayed", OPEN_CENTRE);
    kill(room, "visitor-delayed", 17, 1000);
    assert.equal(visitor.userData?.hp, PLAYER_MAX_HP - 17);
    resolveRead(cumulativeExpForLevel(11));
    await flush();
    assert.equal(room.state.players.get("visitor-delayed")?.level, 11);
    assert.equal(visitor.userData?.hp, PLAYER_MAX_HP + 10 * HP_PER_LEVEL - 17);
  } finally {
    dispose(room);
  }
});

describe("VERIFY the level-1 anchor (§4.2)", () => {
  it("a fresh level-1 session deals and takes exactly today's numbers, with no progressStore at all", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([squirrelAt("m", faced)]);
    try {
      const attacker = join(room, "attacker");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);
      attack(room, attacker, 0);

      // The squirrel's maxHp equals PLAYER_ATTACK_DAMAGE, so a level-1 swing must exactly kill it —
      // any attack bonus at level 1 (a regression of the (level-1)*ATTACK_PER_LEVEL term) would
      // either under- or over-kill relative to the fixture, and this assertion would catch it.
      assert.equal(room.state.monsters.has("m"), false, "one level-1 swing kills a 4-HP monster");

      kill(room, "attacker", 1, 1000);
      const hits = sentOfType<PlayerHit>(attacker, ServerMessage.PlayerHit);
      assert.equal(hits[0]?.hpMax, PLAYER_MAX_HP, "totalMaxHp(level 1, no equipment) === PLAYER_MAX_HP");
    } finally {
      dispose(room);
    }
  });

  it("HP_PER_LEVEL/ATTACK_PER_LEVEL raise both stats once a session has actually leveled up", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([rabbitAt("m", faced)]);
    try {
      const attacker = join(room, "attacker");
      assert.ok(attacker.userData);
      // Level 6: cumulativeExpForLevel(6) is whatever it is — the exact number does not matter to
      // this test, only that levelForExp of it is 6.
      attacker.userData.totalExp = cumulativeExpForLevel(6);
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);

      attack(room, attacker, 0);
      // The rabbit survives one hit (maxHp = 2*PLAYER_ATTACK_DAMAGE), so its remaining HP reveals
      // exactly what this swing dealt: a level-6 attacker hits for
      // PLAYER_ATTACK_DAMAGE + 5 * ATTACK_PER_LEVEL, not the level-1 amount.
      const runtime = room["monsterRuntimes"].get("m");
      assert.ok(runtime);
      assert.equal(
        runtime.hp,
        PLAYER_ATTACK_DAMAGE * 2 - (PLAYER_ATTACK_DAMAGE + 5 * ATTACK_PER_LEVEL),
        "level 6 hits for PLAYER_ATTACK_DAMAGE + 5*ATTACK_PER_LEVEL, not the level-1 amount",
      );

      kill(room, "attacker", 1, 1000);
      const playerHits = sentOfType<PlayerHit>(attacker, ServerMessage.PlayerHit);
      assert.equal(
        playerHits[0]?.hpMax,
        PLAYER_MAX_HP + 5 * HP_PER_LEVEL,
        "level 6's totalMaxHp includes 5 levels' worth of HP_PER_LEVEL",
      );
    } finally {
      dispose(room);
    }
  });
});

// -- grantExp / level-up ---------------------------------------------------------------------------

describe("VERIFY awardExp — grant, level-up and full heal", () => {
  it("credits the store, sends ExpGranted, and leaves level unchanged for a kill that does not cross a threshold", async () => {
    const store = new InMemoryProgressStore();
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([squirrelAt("m", faced)], { progressStore: store });
    try {
      const attacker = join(room, "attacker", undefined, "owner-a");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);

      attack(room, attacker, 0);
      await flush();

      assert.equal(await store.getExp("owner-a"), 4, "squirrel's expReward");
      const grants = sentOfType<ExpGranted>(attacker, ServerMessage.ExpGranted);
      assert.equal(grants.length, 1);
      assert.deepEqual(grants[0], {
        monsterId: "m",
        amount: 4,
        totalExp: 4,
        level: 1,
        expToNextLevel: remainingExpToNextLevel(4),
        hpMax: PLAYER_MAX_HP,
        hpRemaining: PLAYER_MAX_HP,
      });
      assert.equal(room.state.players.get("attacker")?.level, 1, "no level-up yet");
    } finally {
      dispose(room);
    }
  });

  it("raises Player.level and fully heals on the kill that crosses a threshold", async () => {
    const store = new InMemoryProgressStore();
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([deerAt("m", faced)], { progressStore: store });
    try {
      const attacker = join(room, "attacker", undefined, "owner-b");
      assert.ok(attacker.userData);
      attacker.userData.hp = 40; // hurt, so the full heal is observable
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);

      attack(room, attacker, 0);
      await flush();

      const grants = sentOfType<ExpGranted>(attacker, ServerMessage.ExpGranted);
      assert.equal(grants.length, 1);
      assert.equal(grants[0]?.level, 2, "the deer's expReward is exactly expToNextLevel(1)");
      assert.equal(grants[0]?.hpRemaining, grants[0]?.hpMax, "a level-up is always a full heal");
      assert.equal(room.state.players.get("attacker")?.level, 2, "the public schema field moved too");
      assert.equal(
        attacker.userData.hp,
        PLAYER_MAX_HP + HP_PER_LEVEL,
        "session hp was healed to the new, level-2-sized cap — not the old level-1 one",
      );
    } finally {
      dispose(room);
    }
  });

  it("credits nothing and sends nothing with no progressStore configured", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([squirrelAt("m", faced)]);
    try {
      const attacker = join(room, "attacker");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);
      attack(room, attacker, 0);
      await flush();
      assert.equal(sentOfType<ExpGranted>(attacker, ServerMessage.ExpGranted).length, 0);
    } finally {
      dispose(room);
    }
  });
});

// -- last-hit attribution ---------------------------------------------------------------------------

describe("VERIFY EXP attribution is last-hit only (§11-5, loot's own rule reused)", () => {
  it("credits only whoever landed the killing blow, not an earlier attacker", async () => {
    const store = new InMemoryProgressStore();
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([rabbitAt("m", faced)], { progressStore: store });
    try {
      const first = join(room, "first", undefined, "owner-first");
      const last = join(room, "last", undefined, "owner-last");
      place(room, "first", OPEN_CENTRE);
      place(room, "last", { tileX: OPEN_CENTRE.tileX + 2, tileY: OPEN_CENTRE.tileY });
      face(room, "first", Direction.Right);
      face(room, "last", Direction.Left);

      attack(room, first, 0); // rabbit: 8 -> 4, not dead yet
      assert.equal(room.state.monsters.has("m"), true, "precondition: still alive after the first hit");
      attack(room, last, 0); // 4 -> 0, dead
      await flush();

      assert.equal(await store.getExp("owner-last"), 7, "the finishing blow's account is credited");
      assert.equal(await store.getExp("owner-first"), null, "the earlier attacker gets nothing");
      assert.equal(sentOfType<ExpGranted>(first, ServerMessage.ExpGranted).length, 0);
      assert.equal(sentOfType<ExpGranted>(last, ServerMessage.ExpGranted).length, 1);
    } finally {
      dispose(room);
    }
  });
});

// -- death penalty -----------------------------------------------------------------------------------

describe("VERIFY the death EXP penalty (§11.0)", () => {
  /** Far off-tile and fully inert (0 aggro/leash, 0 damage) — its only job is to make hasMonsters
   * true so hydrateProgressCache actually runs on join, the way it would in a real hunting room. */
  const INERT_SPAWN = [squirrelAt("inert", { tileX: 0, tileY: 0 })];

  it("cuts 1% of accumulated EXP on death, and updates the session's own cache", async () => {
    const store = new InMemoryProgressStore();
    await store.grantExp("owner-c", 1000);
    const room = await createRoom(INERT_SPAWN, { progressStore: store });
    try {
      const victim = join(room, "victim", undefined, "owner-c");
      place(room, "victim", OPEN_CENTRE);
      await flush(); // let hydrateProgressCache catch the session cache up to 1000 first
      assert.equal(victim.userData?.totalExp, 1000, "precondition: hydration really ran");

      kill(room, "victim", victim.userData!.hp, 1000);
      await flush();

      assert.equal(await store.getExp("owner-c"), 990, "1000 - round(1000 * 0.01) = 990");
      assert.equal(victim.userData?.totalExp, 990, "the session cache is corrected to the store's answer");
    } finally {
      dispose(room);
    }
  });

  it("never drops a level: the cut floors at the current level's minimum EXP", async () => {
    // level 9's floor is exactly cumulativeExpForLevel(9); 5 EXP above it, 1% of the total (12)
    // would cut 7 EXP below that floor if the clamp did not apply — so this really exercises it,
    // unlike a total small enough that round(total * 0.01) is already 0.
    const floor = cumulativeExpForLevel(9);
    const total = floor + 5;
    assert.ok(Math.round(total * 0.01) > 5, "precondition: an unclamped cut really would cross the floor");
    const store = new InMemoryProgressStore();
    await store.grantExp("owner-d", total);
    const room = await createRoom(INERT_SPAWN, { progressStore: store });
    try {
      const victim = join(room, "victim", undefined, "owner-d");
      place(room, "victim", OPEN_CENTRE);
      await flush();
      assert.equal(levelForExp(victim.userData?.totalExp ?? -1), 9, "precondition: level 9 after hydration");

      kill(room, "victim", victim.userData!.hp, 1000);
      await flush();

      assert.equal(await store.getExp("owner-d"), floor, "clamped at the level-9 floor, not total - the raw cut");
      assert.equal(victim.userData?.totalExp, floor);
    } finally {
      dispose(room);
    }
  });

  it("rounds a sub-1 cut down to 0 at low totals, rather than deducting a fraction", async () => {
    const store = new InMemoryProgressStore();
    await store.grantExp("owner-e", 40); // 1% of 40 is 0.4, which rounds to 0
    const room = await createRoom(INERT_SPAWN, { progressStore: store });
    try {
      const victim = join(room, "victim", undefined, "owner-e");
      place(room, "victim", OPEN_CENTRE);
      await flush();

      kill(room, "victim", victim.userData!.hp, 1000);
      await flush();

      assert.equal(await store.getExp("owner-e"), 40, "round(40 * 0.01) === 0, so nothing is actually cut");
    } finally {
      dispose(room);
    }
  });

  it("exempts an account in adminOwnerKeys entirely", async () => {
    const store = new InMemoryProgressStore();
    await store.grantExp("owner-admin", 1000);
    const room = await createRoom(INERT_SPAWN, {
      progressStore: store,
      adminOwnerKeys: new Set(["owner-admin"]),
    });
    try {
      const victim = join(room, "victim", undefined, "owner-admin");
      place(room, "victim", OPEN_CENTRE);
      await flush();
      assert.equal(victim.userData?.totalExp, 1000, "precondition: hydration really ran");

      kill(room, "victim", victim.userData!.hp, 1000);
      await flush();

      assert.equal(await store.getExp("owner-admin"), 1000, "the allowlisted account loses nothing");
      assert.equal(victim.userData?.totalExp, 1000);
    } finally {
      dispose(room);
    }
  });

  it("does nothing at all with no progressStore configured — no throw, no crash", async () => {
    const room = await createRoom([]);
    try {
      const victim = join(room, "victim");
      place(room, "victim", OPEN_CENTRE);
      kill(room, "victim", PLAYER_MAX_HP, 1000);
      await flush();
      assert.ok(true, "reaching here without throwing is the assertion");
    } finally {
      dispose(room);
    }
  });
});

// -- recovery fraction -------------------------------------------------------------------------------

describe("VERIFY recoverOutOfCombat's fraction conversion (§4.4)", () => {
  it("recovers a level-1 session by exactly 3/tick — the anchor this Phase must not move", async () => {
    const room = await createRoom([]);
    try {
      const hurt = join(room, "hurt");
      place(room, "hurt", OPEN_CENTRE);
      assert.ok(hurt.userData);
      hurt.userData.hp = PLAYER_MAX_HP - 6;
      hurt.userData.lastDamagedAt = 1000;

      room["tick"](1000 + COMBAT_EXIT_MS);
      assert.equal(hurt.userData.hp, PLAYER_MAX_HP - 3, "round(100 * 0.03) === 3, unchanged from today");
    } finally {
      dispose(room);
    }
  });

  it("recovers a leveled-up session proportionally more per tick, not the same flat amount", async () => {
    const room = await createRoom([]);
    try {
      const hurt = join(room, "hurt");
      assert.ok(hurt.userData);
      hurt.userData.totalExp = cumulativeExpForLevel(11); // totalMaxHp = 100 + 10*10 = 200
      place(room, "hurt", OPEN_CENTRE);
      hurt.userData.hp = 200 - 12;
      hurt.userData.lastDamagedAt = 1000;

      room["tick"](1000 + COMBAT_EXIT_MS);
      assert.equal(hurt.userData.hp, 200 - 12 + 6, "round(200 * 0.03) === 6, not the level-1 constant 3");
    } finally {
      dispose(room);
    }
  });
});

// -- grand-plaza shows real levels (Phase W-2a) --------------------------------------------------------

describe("VERIFY grand-plaza shows real levels via a cross-room cache, at most one inner read per account, ever (design-phase-w2-level-client.md §1.3, §1.6)", () => {
  it("hydrates a fresh account from the inner store exactly once — first join, rejoining the same room, and a different room instance are all cache hits after that", async () => {
    const inner = new CountingProgressStore();
    const cached = new CachedProgressStore(inner);
    // Two independent room instances sharing one process-wide cache — production's own wiring
    // (server.ts:103-110 spreads the same `progressStore` reference into every room definition).
    const plaza = await createRoom([], { progressStore: cached });
    const huntingGround = await createRoom(
      [squirrelAt("m", { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY })],
      { progressStore: cached },
    );
    try {
      // First join anywhere, for this account: exactly one cold miss.
      const visitor = join(plaza, "visitor", undefined, "owner-plaza");
      place(plaza, "visitor", OPEN_CENTRE);
      await flush();
      assert.equal(inner.calls, 1, "the first join anywhere costs exactly one inner read");
      assert.equal(
        plaza.state.players.get("visitor")?.level,
        1,
        "no exp granted yet, but the value is real (hydrated), not merely skipped",
      );

      // Leaving and rejoining the *same* room instance is a cache hit, not a second read.
      plaza.onLeave(asRoomClient(visitor));
      await flush();
      join(plaza, "visitor", undefined, "owner-plaza");
      place(plaza, "visitor", OPEN_CENTRE);
      await flush();
      assert.equal(inner.calls, 1, "re-entering the same room instance never re-reads the store");
      plaza.onLeave(asRoomClient(visitor));
      await flush();

      // Hopping into a *different* room instance — the cross-room case W-2 opens up — is also a
      // cache hit: same account, same shared cache, no per-room-instance boundary query.
      join(huntingGround, "visitor2", undefined, "owner-plaza");
      place(huntingGround, "visitor2", OPEN_CENTRE);
      await flush();
      assert.equal(inner.calls, 1, "a different room instance for the same account is still a cache hit");

      // A second, genuinely distinct account is a real cold miss, not a false cache hit.
      join(plaza, "other", undefined, "owner-other");
      place(plaza, "other", OPEN_CENTRE);
      await flush();
      assert.equal(inner.calls, 2, "a different account is a new account, not a cache hit");
    } finally {
      dispose(plaza);
      dispose(huntingGround);
    }
  });

  it("spawns every session at Player.level === 1 when nothing has ever been granted, never an unset/undefined level", async () => {
    const room = await createRoom([]);
    try {
      join(room, "visitor");
      assert.equal(room.state.players.get("visitor")?.level, 1);
    } finally {
      dispose(room);
    }
  });
});
