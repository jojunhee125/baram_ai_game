import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATTACK_COOLDOWN_MS,
  ATTACK_PER_LEVEL,
  CLASS_DEFINITIONS,
  COMBAT_EXIT_MS,
  Direction,
  HP_PER_LEVEL,
  LEVEL_CAP,
  MONSTER_TICK_MS,
  MP_COMBAT_RECOVERY_FRACTION_PER_TICK,
  MP_RECOVERY_FRACTION_PER_TICK,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_MAX_HP,
  PlayerClassKey,
  SKILL_DEFINITIONS,
  ServerMessage,
  SkillKey,
  classCodeFor,
  cumulativeExpForLevel,
  expToNextLevel,
  levelForExp,
  remainingExpToNextLevel,
  type ClassChanged,
  type ClassDenied,
  type ExpGranted,
  type JoinOptions,
  type MonsterHit,
  type PartyInvited,
  type PlayerHealed,
  type PlayerHit,
  type SkillDenied,
  type SkillUsed,
  type TilePosition,
} from "@zep-test/shared";
import { InMemoryClassStore, type ClassStore } from "../db/classStore";
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
    assert.equal(expToNextLevel(1), Math.round(20 * 1 ** 1.7));
    assert.equal(expToNextLevel(29), Math.round(20 * 29 ** 1.7));
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

  // Was ~34,000 until the 2026-09-17 retune doubled the curve's coefficient (decisions.md
  // "왕초보 사냥터 EXP·레벨 곡선 8배 하향"); the other 4x of that change lives in the monster table.
  it("sums to roughly 69,000 cumulative EXP by the cap", () => {
    const total = cumulativeExpForLevel(LEVEL_CAP);
    assert.ok(total > 62_000 && total < 76_000, `expected ~69,000, got ${total}`);
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

function formParty(room: MetaverseRoom, leader: FakeClient, member: FakeClient): void {
  const now = Date.now();
  room["parties"].create(leader.sessionId, now);
  room["parties"].invite(leader.sessionId, { targetSessionId: member.sessionId }, now);
  const invitation = sentOfType<PartyInvited>(member, ServerMessage.PartyInvited).at(-1);
  assert.ok(invitation);
  room["parties"].respond(member.sessionId, { inviteId: invitation.inviteId, accept: true }, now);
  assert.equal(room["parties"].sameParty(leader.sessionId, member.sessionId), true);
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
  room.onDispose();
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

it("account progress synchronizes grants and penalties across rooms without rewarding other accounts", async () => {
  const store = new CachedProgressStore(new InMemoryProgressStore());
  const first = await createRoom([], { progressStore: store });
  const second = await createRoom([], { progressStore: store });
  try {
    const actor = join(first, "actor", undefined, "shared-owner");
    const peer = join(second, "peer", undefined, "shared-owner");
    const other = join(second, "other", undefined, "other-owner");
    await flush();
    actor.userData!.hp = 40;
    peer.userData!.hp = 30;
    const total = cumulativeExpForLevel(10) + 50;
    await first["awardExp"]({ sessionId: "actor", ownerKey: "shared-owner" }, "kill", total, 1000);
    const cap = PLAYER_MAX_HP + 9 * HP_PER_LEVEL;
    for (const [room, client] of [[first, actor], [second, peer]] as const) {
      assert.equal(client.userData!.totalExp, total);
      assert.equal(room.state.players.get(client.sessionId)?.level, 10);
      assert.equal(room["totalAttack"](asRoomClient(client).userData!), PLAYER_ATTACK_DAMAGE + 9 * ATTACK_PER_LEVEL);
      assert.equal(room["totalMaxHp"](asRoomClient(client).userData!), cap);
      assert.equal(client.userData!.hp, cap);
    }
    assert.equal(other.userData!.totalExp, 0);
    assert.equal(second.state.players.get("other")?.level, 1);
    assert.equal(sentOfType<ExpGranted>(actor, ServerMessage.ExpGranted).length, 1);
    assert.equal(sentOfType<ExpGranted>(peer, ServerMessage.ExpGranted).length, 0);
    kill(first, "actor", 13, 1001);
    kill(second, "peer", cap, 1002);
    await flush();
    const afterDeath = Math.max(cumulativeExpForLevel(10), total - Math.round(total * 0.01));
    assert.equal(actor.userData!.totalExp, afterDeath);
    assert.equal(peer.userData!.totalExp, afterDeath);
    assert.equal(actor.userData!.hp, cap - 13);
    assert.equal(first.state.players.get("actor")?.level, 10);
  } finally {
    dispose(first);
    dispose(second);
  }
});

it("account progress rejects an initial snapshot overtaken by a lower death total", async () => {
  const store = new CachedProgressStore(new InMemoryProgressStore());
  await store.grantExp("snapshot-owner", 1000);
  let resolveRead!: (value: number) => void;
  const snapshot = new Promise<number>((resolve) => { resolveRead = resolve; });
  store.getExp = () => snapshot;
  const room = await createRoom([], { progressStore: store });
  try {
    const client = join(room, "snapshot", undefined, "snapshot-owner");
    await store.applyDeathPenalty("snapshot-owner", cumulativeExpForLevel(levelForExp(1000)));
    assert.equal(client.userData!.totalExp, 990);
    resolveRead(1000);
    await flush();
    assert.equal(client.userData!.totalExp, 990);
    assert.equal(room.state.players.get("snapshot")?.level, levelForExp(990));
  } finally {
    dispose(room);
  }
});

it("account progress unsubscribes on leave and disposal and hydrates a later arrival from cache", async () => {
  const inner = new CountingProgressStore();
  const store = new CachedProgressStore(inner);
  const first = await createRoom([], { progressStore: store });
  const second = await createRoom([], { progressStore: store });
  try {
    const left = join(first, "left", undefined, "lifecycle-owner");
    const disposed = join(second, "disposed", undefined, "lifecycle-owner");
    await flush();
    assert.equal(inner.calls, 1);
    first.onLeave(asRoomClient(left));
    second.onDispose();
    await store.grantExp("lifecycle-owner", 1000);
    assert.equal(left.userData!.totalExp, 0);
    assert.equal(disposed.userData!.totalExp, 0);
    const arrival = join(first, "arrival", undefined, "lifecycle-owner");
    await flush();
    assert.equal(arrival.userData!.totalExp, 1000);
    assert.equal(inner.calls, 2);
  } finally {
    dispose(first);
    dispose(second);
  }
});

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

// -- R05-a: class multipliers, MP, and the class picker --------------------------------------------

describe("VERIFY R05-a class multipliers and MP (docs/r05-classes-and-skills.md D3/D4)", () => {
  it("leaves an unchosen player's totalAttack/totalMaxHp exactly where Phase W left them, and MP at 0", async () => {
    const room = await createRoom([], { classStore: new InMemoryClassStore() });
    try {
      const visitor = join(room, "unchosen", undefined, "owner-unchosen");
      await flush();
      const session = asRoomClient(visitor).userData!;
      assert.equal(session.playerClass, null);
      assert.equal(room["totalAttack"](session), PLAYER_ATTACK_DAMAGE);
      assert.equal(room["totalMaxHp"](session), PLAYER_MAX_HP);
      assert.equal(room["totalMaxMp"](session), 0);
      assert.equal(session.mp, 0);
    } finally {
      dispose(room);
    }
  });

  it("matches every class's own multiplier table exactly, at level 1", async () => {
    for (const classKey of Object.values(PlayerClassKey)) {
      const store = new InMemoryClassStore();
      await store.chooseOnce(`owner-${classKey}`, classKey);
      const room = await createRoom([], { classStore: store });
      try {
        const visitor = join(room, `chosen-${classKey}`, undefined, `owner-${classKey}`);
        await flush();
        const session = asRoomClient(visitor).userData!;
        const definition = CLASS_DEFINITIONS[classKey];
        assert.equal(session.playerClass, classKey);
        assert.equal(
          room["totalAttack"](session),
          Math.max(1, Math.round(PLAYER_ATTACK_DAMAGE * definition.attackMultiplier)),
          `${classKey} attack`,
        );
        assert.equal(
          room["totalMaxHp"](session),
          Math.max(1, Math.round(PLAYER_MAX_HP * definition.maxHpMultiplier)),
          `${classKey} maxHp`,
        );
        assert.equal(room["totalMaxMp"](session), definition.maxMpBase, `${classKey} maxMp`);
        assert.equal(session.mp, definition.maxMpBase, `${classKey} is full-on-join once chosen`);
      } finally {
        dispose(room);
      }
    }
  });

  it("regenerates MP out of combat, and more slowly while in combat", async () => {
    const store = new InMemoryClassStore();
    await store.chooseOnce("owner-shaman", PlayerClassKey.Shaman);
    const room = await createRoom([], { classStore: store });
    try {
      const visitor = join(room, "shaman-mp", undefined, "owner-shaman");
      await flush();
      place(room, "shaman-mp", OPEN_CENTRE);
      const session = asRoomClient(visitor).userData!;
      const mpCap = CLASS_DEFINITIONS[PlayerClassKey.Shaman].maxMpBase; // 100

      session.mp = 0;
      session.lastDamagedAt = 0; // never hit — out of combat by the time `now` is large
      room["tick"](1_000_000);
      assert.equal(
        session.mp,
        Math.max(1, Math.round(mpCap * MP_RECOVERY_FRACTION_PER_TICK)),
        "out-of-combat fraction",
      );

      session.mp = 0;
      session.lastDamagedAt = 1_000_000; // hit just now — inside COMBAT_EXIT_MS of the next tick
      room["tick"](1_000_000 + 1);
      assert.equal(
        session.mp,
        Math.max(1, Math.round(mpCap * MP_COMBAT_RECOVERY_FRACTION_PER_TICK)),
        "in-combat fraction is the smaller trickle, not zero and not the out-of-combat rate",
      );
    } finally {
      dispose(room);
    }
  });

  it("keeps a chosen class, its stats and its MP across a rejoin", async () => {
    const store = new InMemoryClassStore();
    const room = await createRoom([], { classStore: store });
    try {
      const firstVisit = join(room, "first-visit", undefined, "owner-rejoin");
      await flush();
      room["handleChooseClass"](asRoomClient(firstVisit), { classKey: PlayerClassKey.Rogue });
      await flush();
      room.onLeave(asRoomClient(firstVisit));

      const rejoined = join(room, "second-visit", undefined, "owner-rejoin");
      await flush();
      const session = asRoomClient(rejoined).userData!;
      assert.equal(session.playerClass, PlayerClassKey.Rogue);
      assert.equal(room["totalMaxMp"](session), CLASS_DEFINITIONS[PlayerClassKey.Rogue].maxMpBase);
      assert.equal(session.mp, CLASS_DEFINITIONS[PlayerClassKey.Rogue].maxMpBase);
    } finally {
      dispose(room);
    }
  });

  it("sends ClassChanged once at join, classKey null for an account that has never chosen", async () => {
    const room = await createRoom([], { classStore: new InMemoryClassStore() });
    try {
      const visitor = join(room, "never-chosen", undefined, "owner-never-chosen");
      await flush();
      const changes = sentOfType<ClassChanged>(visitor, ServerMessage.ClassChanged);
      assert.equal(changes.length, 1);
      assert.deepEqual(changes[0], {
        classKey: null,
        classCode: 0,
        hpRemaining: PLAYER_MAX_HP,
        hpMax: PLAYER_MAX_HP,
        mpRemaining: 0,
        mpMax: 0,
      });
    } finally {
      dispose(room);
    }
  });

  it("answers a successful class:choose with ClassChanged and persists it; replaying it is idempotent", async () => {
    const store = new InMemoryClassStore();
    const room = await createRoom([], { classStore: store });
    try {
      const visitor = join(room, "chooser", undefined, "owner-chooser");
      await flush();

      room["handleChooseClass"](asRoomClient(visitor), { classKey: PlayerClassKey.Warrior });
      await flush();
      assert.equal(await store.getClass("owner-chooser"), PlayerClassKey.Warrior);
      let changes = sentOfType<ClassChanged>(visitor, ServerMessage.ClassChanged);
      assert.equal(changes.length, 2, "the join sync, then the choice");
      assert.equal(changes[1]?.classKey, PlayerClassKey.Warrior);
      assert.equal(sentOfType<ClassDenied>(visitor, ServerMessage.ClassDenied).length, 0);

      // Replaying the same choice must not deny it and must not change the stored class.
      room["handleChooseClass"](asRoomClient(visitor), { classKey: PlayerClassKey.Warrior });
      await flush();
      assert.equal(await store.getClass("owner-chooser"), PlayerClassKey.Warrior);
      changes = sentOfType<ClassChanged>(visitor, ServerMessage.ClassChanged);
      assert.equal(changes.length, 3, "the replay still answers, it just changes nothing");
      assert.equal(sentOfType<ClassDenied>(visitor, ServerMessage.ClassDenied).length, 0);
    } finally {
      dispose(room);
    }
  });

  it("denies already-chosen for a different class, and settles the picker on the stored one", async () => {
    const store = new InMemoryClassStore();
    const room = await createRoom([], { classStore: store });
    try {
      const visitor = join(room, "second-guesser", undefined, "owner-second-guesser");
      await flush();
      room["handleChooseClass"](asRoomClient(visitor), { classKey: PlayerClassKey.Cleric });
      await flush();

      room["handleChooseClass"](asRoomClient(visitor), { classKey: PlayerClassKey.Rogue });
      await flush();

      const denials = sentOfType<ClassDenied>(visitor, ServerMessage.ClassDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "already-chosen");
      const changes = sentOfType<ClassChanged>(visitor, ServerMessage.ClassChanged);
      assert.equal(changes.at(-1)?.classKey, PlayerClassKey.Cleric, "settles on the stored class, not the request");
      assert.equal(await store.getClass("owner-second-guesser"), PlayerClassKey.Cleric, "never overwritten");
    } finally {
      dispose(room);
    }
  });

  it("does not let a stale join-time read undo a class chosen while hydration was still pending", async () => {
    // Simulates a real-Postgres timing window: `hydrateClassCache`'s `getClass` is issued at
    // join and is still in flight (imagine network latency) when `class:choose` arrives and
    // completes first on a separate, faster round trip.
    class DelayedGetClassStore implements ClassStore {
      private readonly inner = new InMemoryClassStore();
      private release: ((value: PlayerClassKey | null) => void) | null = null;

      getClass(ownerKey: string): Promise<PlayerClassKey | null> {
        return new Promise((resolve) => {
          this.release = resolve;
          void ownerKey;
        });
      }

      chooseOnce(ownerKey: string, classKey: string): Promise<PlayerClassKey> {
        return this.inner.chooseOnce(ownerKey, classKey);
      }

      releasePendingGetClass(value: PlayerClassKey | null): void {
        assert.ok(this.release, "getClass must have been called before releasing it");
        this.release!(value);
      }
    }

    const store = new DelayedGetClassStore();
    const room = await createRoom([], { classStore: store });
    try {
      const visitor = join(room, "racer", undefined, "owner-racer");
      // `hydrateClassCache`'s `getClass(owner-racer)` is now pending, unresolved.

      room["handleChooseClass"](asRoomClient(visitor), { classKey: PlayerClassKey.Warrior });
      await flush();

      const session = asRoomClient(visitor).userData!;
      assert.equal(session.playerClass, PlayerClassKey.Warrior, "precondition: the live pick landed first");
      assert.equal(session.mp, CLASS_DEFINITIONS[PlayerClassKey.Warrior].maxMpBase, "precondition: MP filled");

      // The stale read finally resolves with what it saw *before* the choice: unchosen.
      store.releasePendingGetClass(null);
      await flush();

      assert.equal(
        session.playerClass,
        PlayerClassKey.Warrior,
        "a stale join-time read must not undo a class chosen while it was in flight",
      );
      assert.equal(
        room.state.players.get("racer")?.playerClass,
        classCodeFor(PlayerClassKey.Warrior),
        "the public schema field must not be reverted either",
      );
      assert.equal(
        session.mp,
        CLASS_DEFINITIONS[PlayerClassKey.Warrior].maxMpBase,
        "MP must not be reset to 0 by the stale hydration resolving late",
      );
    } finally {
      dispose(room);
    }
  });

  it("denies unknown-class for an invalid key without ever touching the store", async () => {
    const store = new InMemoryClassStore();
    const room = await createRoom([], { classStore: store });
    try {
      const visitor = join(room, "typo", undefined, "owner-typo");
      await flush();
      room["handleChooseClass"](asRoomClient(visitor), { classKey: "wizard" });
      await flush();

      const denials = sentOfType<ClassDenied>(visitor, ServerMessage.ClassDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "unknown-class");
      assert.equal(await store.getClass("owner-typo"), null);
    } finally {
      dispose(room);
    }
  });
});

// -- R05-b: skill execution contract ---------------------------------------------------------------

function useSkill(
  room: MetaverseRoom,
  client: FakeClient,
  skillKey: string,
  targetSessionId?: string,
  nonce = "n",
): void {
  room["handleUseSkill"](asRoomClient(client), { skillKey, targetSessionId, nonce });
}

async function classRoom(
  classKey: PlayerClassKey,
  spawns: readonly MonsterSpawnDefinition[] = [],
): Promise<VerifyRoom> {
  const store = new InMemoryClassStore();
  await store.chooseOnce(`owner-${classKey}`, classKey);
  return createRoom(spawns, { classStore: store });
}

describe("VERIFY R05-b skill execution contract (docs/r05-classes-and-skills.md D5/D6/D7/D8)", () => {
  it("resolves guard-stance (warrior, self-target) end to end: charges MP and stamps its own cooldown", async () => {
    const room = await classRoom(PlayerClassKey.Warrior);
    try {
      const client = join(room, "warrior", undefined, `owner-${PlayerClassKey.Warrior}`);
      await flush();
      const session = asRoomClient(client).userData!;
      const definition = SKILL_DEFINITIONS[SkillKey.GuardStance];
      if (definition.effect.kind !== "self-damage-reduction") {
        throw new Error("fixture assumption: guard-stance is a self-damage-reduction skill");
      }
      const mpBefore = session.mp;

      const before = Date.now();
      useSkill(room, client, SkillKey.GuardStance);
      const after = Date.now();

      assert.equal(session.mp, mpBefore - definition.mpCost);
      const cooldown = session.skillCooldowns.get(SkillKey.GuardStance);
      assert.ok(cooldown !== undefined);
      assert.ok(cooldown! >= before + definition.cooldownMs && cooldown! <= after + definition.cooldownMs);
      assert.ok(session.stanceDamageReductionUntil >= before + definition.effect.durationMs);
      assert.equal(session.stanceDamageReduction, definition.effect.damageReduction);
      assert.equal(sentOfType<SkillDenied>(client, ServerMessage.SkillDenied).length, 0);
      const used = sentOfType<SkillUsed>(client, ServerMessage.SkillUsed);
      assert.equal(used.length, 1);
      assert.equal(used[0]?.skillKey, SkillKey.GuardStance);
      assert.equal(used[0]?.mpRemaining, session.mp, "the caster's own copy carries MP");
      assert.equal(used[0]?.mpMax, CLASS_DEFINITIONS[PlayerClassKey.Warrior].maxMpBase);
    } finally {
      dispose(room);
    }
  });

  it("the warrior's stance reduction composes multiplicatively with equipped armor, and stops applying once its deadline passes", async () => {
    const room = await classRoom(PlayerClassKey.Warrior);
    try {
      const client = join(room, "tank", undefined, `owner-${PlayerClassKey.Warrior}`);
      await flush();
      const session = asRoomClient(client).userData!;
      session.equippedItemKeys.armor = "leather-armor"; // 0.2 damageReduction
      session.hp = 1000; // headroom so neither hit crosses into the death branch, which would clear the stance
      session.stanceDamageReductionUntil = 5_000;
      session.stanceDamageReduction = 0.5;

      room["damagePlayer"]("tank", "any-monster", 100, 1_000); // stance active (1000 < 5000)
      // stance clears immediately at its own deadline; a monster tick that lands one ms into
      // the deadline must already read it as expired, not one tick later.
      room["damagePlayer"]("tank", "any-monster", 100, 5_000);

      const hits = sentOfType<PlayerHit>(client, ServerMessage.PlayerHit);
      assert.equal(hits.length, 2);
      // Combined: 1 - (1-0.2)(1-0.5) = 0.6 -> floor(100*0.4) = 40
      assert.equal(hits[0]?.damage, 40, "armor and stance combine multiplicatively while the stance is active");
      // Stance expired: only the 0.2 armor term remains -> floor(100*0.8) = 80
      assert.equal(hits[1]?.damage, 80, "the stance term drops out once now reaches its own deadline");
    } finally {
      dispose(room);
    }
  });

  it("resolves ambush (rogue, monster-target) end to end: damage equals totalAttack x attackMultiplier", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await classRoom(PlayerClassKey.Rogue, [squirrelAt("m", faced)]);
    try {
      const client = join(room, "rogue", undefined, `owner-${PlayerClassKey.Rogue}`);
      await flush();
      place(room, "rogue", OPEN_CENTRE);
      const session = asRoomClient(client).userData!;
      const definition = SKILL_DEFINITIONS[SkillKey.Ambush];
      if (definition.effect.kind !== "monster-damage") {
        throw new Error("fixture assumption: ambush is a monster-damage skill");
      }
      const expectedDamage = Math.max(
        1,
        Math.round(room["totalAttack"](session) * definition.effect.attackMultiplier),
      );

      useSkill(room, client, SkillKey.Ambush);

      const hits = sentOfType<MonsterHit>(client, ServerMessage.MonsterHit);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.damage, expectedDamage);
      assert.equal(sentOfType<SkillDenied>(client, ServerMessage.SkillDenied).length, 0);
    } finally {
      dispose(room);
    }
  });

  it("resolves fireball (shaman, monster-target) end to end at its own 4-tile range", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 4, tileY: OPEN_CENTRE.tileY };
    const room = await classRoom(PlayerClassKey.Shaman, [squirrelAt("m", faced)]);
    try {
      const client = join(room, "shaman", undefined, `owner-${PlayerClassKey.Shaman}`);
      await flush();
      place(room, "shaman", OPEN_CENTRE);
      const session = asRoomClient(client).userData!;
      const definition = SKILL_DEFINITIONS[SkillKey.Fireball];
      if (definition.effect.kind !== "monster-damage") {
        throw new Error("fixture assumption: fireball is a monster-damage skill");
      }
      const expectedDamage = Math.max(
        1,
        Math.round(room["totalAttack"](session) * definition.effect.attackMultiplier),
      );

      useSkill(room, client, SkillKey.Fireball);

      const hits = sentOfType<MonsterHit>(client, ServerMessage.MonsterHit);
      assert.equal(hits.length, 1, "a target 4 tiles away is still in fireball's own range");
      assert.equal(hits[0]?.damage, expectedDamage);
    } finally {
      dispose(room);
    }
  });

  it("resolves heal (cleric, ally-target) end to end, reaching a different client than the caster", async () => {
    const room = await classRoom(PlayerClassKey.Cleric);
    try {
      const caster = join(room, "cleric", undefined, `owner-${PlayerClassKey.Cleric}`);
      const ally = join(room, "hurt-ally", undefined, "owner-ally");
      await flush();
      formParty(room, caster, ally);
      place(room, "cleric", OPEN_CENTRE);
      place(room, "hurt-ally", { tileX: OPEN_CENTRE.tileX + 2, tileY: OPEN_CENTRE.tileY });
      const allySession = asRoomClient(ally).userData!;
      allySession.hp = 50; // 50/100, well clear of the max-HP clamp
      const definition = SKILL_DEFINITIONS[SkillKey.Heal];
      if (definition.effect.kind !== "ally-heal") {
        throw new Error("fixture assumption: heal is an ally-heal skill");
      }
      const expectedHeal = Math.round(PLAYER_MAX_HP * definition.effect.healFractionOfTargetMaxHp);

      useSkill(room, caster, SkillKey.Heal, "hurt-ally");

      assert.equal(allySession.hp, 50 + expectedHeal);
      const casterHeals = sentOfType<PlayerHealed>(caster, ServerMessage.PlayerHealed);
      const allyHeals = sentOfType<PlayerHealed>(ally, ServerMessage.PlayerHealed);
      assert.equal(casterHeals.length, 1);
      assert.equal(allyHeals.length, 1);
      assert.deepEqual(casterHeals[0], allyHeals[0]);
      assert.equal(casterHeals[0]?.targetSessionId, "hurt-ally");
      assert.equal(casterHeals[0]?.healAmount, expectedHeal);
    } finally {
      dispose(room);
    }
  });

  it("clamps heal at the target's max HP — never an overheal", async () => {
    const room = await classRoom(PlayerClassKey.Cleric);
    try {
      const caster = join(room, "cleric2", undefined, `owner-${PlayerClassKey.Cleric}`);
      const ally = join(room, "almost-full", undefined, "owner-almost-full");
      await flush();
      formParty(room, caster, ally);
      place(room, "cleric2", OPEN_CENTRE);
      place(room, "almost-full", { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY });
      const allySession = asRoomClient(ally).userData!;
      allySession.hp = PLAYER_MAX_HP - 10; // only 10 HP of headroom, less than the 30 the skill would grant

      useSkill(room, caster, SkillKey.Heal, "almost-full");

      assert.equal(allySession.hp, PLAYER_MAX_HP, "clamped to the cap, not over it");
      const heals = sentOfType<PlayerHealed>(ally, ServerMessage.PlayerHealed);
      assert.equal(heals[0]?.healAmount, 10, "only the actual headroom was healed");
    } finally {
      dispose(room);
    }
  });

  // -- denial reasons -------------------------------------------------------------------------------

  it("denies healing a nearby nonparty player without spending MP", async () => {
    const room = await classRoom(PlayerClassKey.Cleric);
    try {
      const caster = join(room, "cleric-nonparty", undefined, `owner-${PlayerClassKey.Cleric}`);
      const stranger = join(room, "stranger", undefined, "owner-stranger");
      await flush();
      place(room, caster.sessionId, OPEN_CENTRE);
      place(room, stranger.sessionId, OPEN_CENTRE);
      const target = asRoomClient(stranger).userData!;
      target.hp = 40;
      const mp = asRoomClient(caster).userData!.mp;
      useSkill(room, caster, SkillKey.Heal, stranger.sessionId);
      assert.equal(target.hp, 40);
      assert.equal(asRoomClient(caster).userData!.mp, mp);
      assert.equal(sentOfType<SkillDenied>(caster, ServerMessage.SkillDenied).at(-1)?.reason, "no-target");
      assert.equal(sentOfType<PlayerHealed>(stranger, ServerMessage.PlayerHealed).length, 0);
    } finally { dispose(room); }
  });

  it("denies no-class before ever looking at the skill key, and stamps no cooldown", async () => {
    const room = await createRoom([], { classStore: new InMemoryClassStore() });
    try {
      const client = join(room, "unchosen", undefined, "owner-unchosen");
      await flush();
      const session = asRoomClient(client).userData!;

      useSkill(room, client, SkillKey.GuardStance);

      const denials = sentOfType<SkillDenied>(client, ServerMessage.SkillDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "no-class");
      assert.equal(session.skillCooldowns.size, 0, "a denial before the stamp costs nothing");
    } finally {
      dispose(room);
    }
  });

  it("denies unknown-skill for a key with no definition, and for a key this class does not own", async () => {
    const room = await classRoom(PlayerClassKey.Warrior);
    try {
      const client = join(room, "warrior2", undefined, `owner-${PlayerClassKey.Warrior}`);
      await flush();

      useSkill(room, client, "not-a-real-skill");
      useSkill(room, client, SkillKey.Heal); // real skill, but the cleric's, not the warrior's

      const denials = sentOfType<SkillDenied>(client, ServerMessage.SkillDenied);
      assert.equal(denials.length, 2);
      assert.equal(denials[0]?.reason, "unknown-skill");
      assert.equal(denials[1]?.reason, "unknown-skill");
    } finally {
      dispose(room);
    }
  });

  it("denies on-cooldown for a second cast inside the skill's own window, without spending MP twice", async () => {
    const room = await classRoom(PlayerClassKey.Warrior);
    try {
      const client = join(room, "warrior3", undefined, `owner-${PlayerClassKey.Warrior}`);
      await flush();
      const session = asRoomClient(client).userData!;

      useSkill(room, client, SkillKey.GuardStance);
      const mpAfterFirstCast = session.mp;
      useSkill(room, client, SkillKey.GuardStance);

      assert.equal(session.mp, mpAfterFirstCast, "a denied recast must not spend MP a second time");
      const denials = sentOfType<SkillDenied>(client, ServerMessage.SkillDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "on-cooldown");
    } finally {
      dispose(room);
    }
  });

  it("denies insufficient-mp without stamping the cooldown", async () => {
    const room = await classRoom(PlayerClassKey.Warrior);
    try {
      const client = join(room, "warrior4", undefined, `owner-${PlayerClassKey.Warrior}`);
      await flush();
      const session = asRoomClient(client).userData!;
      session.mp = 0;

      useSkill(room, client, SkillKey.GuardStance);

      const denials = sentOfType<SkillDenied>(client, ServerMessage.SkillDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "insufficient-mp");
      assert.equal(session.skillCooldowns.size, 0, "a denial before the stamp costs nothing");
    } finally {
      dispose(room);
    }
  });

  it("denies no-target for a monster skill in a room with no monsters, but still stamps the cooldown and spares the MP", async () => {
    const room = await classRoom(PlayerClassKey.Rogue); // no spawns at all -> hasMonsters === false
    try {
      const client = join(room, "rogue2", undefined, `owner-${PlayerClassKey.Rogue}`);
      await flush();
      const session = asRoomClient(client).userData!;
      const mpBefore = session.mp;

      useSkill(room, client, SkillKey.Ambush);

      const denials = sentOfType<SkillDenied>(client, ServerMessage.SkillDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "no-target");
      assert.equal(session.mp, mpBefore, "an unresolved target must never be charged MP");
      assert.equal(session.skillCooldowns.get(SkillKey.Ambush) !== undefined, true, "the cooldown is spent regardless");
    } finally {
      dispose(room);
    }
  });

  it("denies no-target for an ally skill with no targetSessionId, and for one that resolves to nobody in this room", async () => {
    const room = await classRoom(PlayerClassKey.Cleric);
    try {
      const client = join(room, "cleric3", undefined, `owner-${PlayerClassKey.Cleric}`);
      await flush();

      useSkill(room, client, SkillKey.Heal); // no targetSessionId at all

      const denials = sentOfType<SkillDenied>(client, ServerMessage.SkillDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "no-target");
    } finally {
      dispose(room);
    }
  });

  it("denies out-of-range for an ally beyond the skill's own reach", async () => {
    const room = await classRoom(PlayerClassKey.Cleric);
    try {
      const caster = join(room, "cleric4", undefined, `owner-${PlayerClassKey.Cleric}`);
      const ally = join(room, "far-ally", undefined, "owner-far-ally");
      await flush();
      formParty(room, caster, ally);
      place(room, "cleric4", OPEN_CENTRE);
      place(room, "far-ally", { tileX: OPEN_CENTRE.tileX + 5, tileY: OPEN_CENTRE.tileY }); // heal's range is 3
      const session = asRoomClient(caster).userData!;
      const mpBefore = session.mp;

      useSkill(room, caster, SkillKey.Heal, "far-ally");

      const denials = sentOfType<SkillDenied>(caster, ServerMessage.SkillDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "out-of-range");
      assert.equal(session.mp, mpBefore);
    } finally {
      dispose(room);
    }
  });

  it("denies target-dead for an ally at 0 HP", async () => {
    const room = await classRoom(PlayerClassKey.Cleric);
    try {
      const caster = join(room, "cleric5", undefined, `owner-${PlayerClassKey.Cleric}`);
      const ally = join(room, "downed-ally", undefined, "owner-downed-ally");
      await flush();
      formParty(room, caster, ally);
      place(room, "cleric5", OPEN_CENTRE);
      place(room, "downed-ally", OPEN_CENTRE);
      asRoomClient(ally).userData!.hp = 0;
      const session = asRoomClient(caster).userData!;
      const mpBefore = session.mp;

      useSkill(room, caster, SkillKey.Heal, "downed-ally");

      const denials = sentOfType<SkillDenied>(caster, ServerMessage.SkillDenied);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.reason, "target-dead");
      assert.equal(session.mp, mpBefore);
    } finally {
      dispose(room);
    }
  });

  // -- D5: independent cooldown budgets --------------------------------------------------------------

  it("a skill never consumes or checks lastAttackAt, in either direction", async () => {
    const room = await classRoom(PlayerClassKey.Warrior);
    try {
      const client = join(room, "warrior5", undefined, `owner-${PlayerClassKey.Warrior}`);
      await flush();
      const session = asRoomClient(client).userData!;
      // Just attacked, well inside ATTACK_COOLDOWN_MS — if a skill wrongly checked this, it would
      // be denied on-cooldown even though its own, separate budget is untouched.
      session.lastAttackAt = Date.now();
      const lastAttackBefore = session.lastAttackAt;

      useSkill(room, client, SkillKey.GuardStance);

      assert.equal(sentOfType<SkillDenied>(client, ServerMessage.SkillDenied).length, 0, "a fresh auto-attack must never gate a skill");
      assert.equal(session.lastAttackAt, lastAttackBefore, "a skill must never write lastAttackAt");
    } finally {
      dispose(room);
    }
  });

  it("an attack never consumes or checks any skill cooldown, in either direction", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await classRoom(PlayerClassKey.Warrior, [squirrelAt("m", faced)]);
    try {
      const client = join(room, "warrior6", undefined, `owner-${PlayerClassKey.Warrior}`);
      await flush();
      place(room, "warrior6", OPEN_CENTRE);
      face(room, "warrior6", Direction.Right);
      const session = asRoomClient(client).userData!;
      // guard-stance deep on cooldown — if handleAttack wrongly consulted this, the swing below
      // would be silently dropped even though ATTACK_COOLDOWN_MS itself was never touched.
      const farFuture = Date.now() + 999_999;
      session.skillCooldowns.set(SkillKey.GuardStance, farFuture);

      attack(room, client, 0);

      assert.equal(room.state.monsters.has("m"), false, "the swing must land — a skill cooldown must never gate it");
      assert.equal(session.skillCooldowns.get(SkillKey.GuardStance), farFuture, "an attack must never touch a skill's cooldown");
    } finally {
      dispose(room);
    }
  });

  // -- anchor invariant -------------------------------------------------------------------------------

  it("leaves an unchosen account's attack exactly at PLAYER_ATTACK_DAMAGE after the R05-b changes", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([rabbitAt("m", faced)]);
    try {
      const client = join(room, "plain-attacker");
      place(room, "plain-attacker", OPEN_CENTRE);
      face(room, "plain-attacker", Direction.Right);

      attack(room, client, 0);

      const runtime = room["monsterRuntimes"].get("m");
      assert.ok(runtime);
      assert.equal(runtime.hp, PLAYER_ATTACK_DAMAGE * 2 - PLAYER_ATTACK_DAMAGE, "unchanged by pickAttackTarget's new radius parameter");
    } finally {
      dispose(room);
    }
  });

  // -- death refills MP and clears any active stance -------------------------------------------------

  it("refills MP to its max on death, and clears an active stance deadline", async () => {
    const room = await classRoom(PlayerClassKey.Warrior);
    try {
      const client = join(room, "warrior7", undefined, `owner-${PlayerClassKey.Warrior}`);
      await flush();
      const session = asRoomClient(client).userData!;
      session.mp = 1;
      session.hp = 5;
      session.stanceDamageReductionUntil = Date.now() + 999_999;
      session.stanceDamageReduction = 0.5;

      kill(room, "warrior7", 999, 1_000); // far more than session.hp -> death branch

      assert.equal(session.mp, room["totalMaxMp"](session), "MP is full on death, HP's own rule");
      assert.equal(session.stanceDamageReductionUntil, 0, "death clears an active stance the way it resets HP");
    } finally {
      dispose(room);
    }
  });

  // -- D3: MP never reaches an onlooker ----------------------------------------------------------------

  it("omits mpRemaining/mpMax entirely from the onlooker's copy of SkillUsed", async () => {
    const room = await classRoom(PlayerClassKey.Warrior);
    try {
      const caster = join(room, "warrior8", undefined, `owner-${PlayerClassKey.Warrior}`);
      const onlooker = join(room, "onlooker", undefined, "owner-onlooker");
      await flush();
      place(room, "warrior8", OPEN_CENTRE);
      place(room, "onlooker", OPEN_CENTRE);

      useSkill(room, caster, SkillKey.GuardStance);

      const casterCopy = sentOfType<SkillUsed>(caster, ServerMessage.SkillUsed);
      const onlookerCopy = sentOfType<SkillUsed>(onlooker, ServerMessage.SkillUsed);
      assert.equal(casterCopy.length, 1);
      assert.equal(onlookerCopy.length, 1);
      assert.equal(Object.hasOwn(casterCopy[0]!, "mpRemaining"), true, "the caster's own copy carries MP");
      assert.equal(Object.hasOwn(onlookerCopy[0]!, "mpRemaining"), false, "an onlooker must never receive the number");
      assert.equal(Object.hasOwn(onlookerCopy[0]!, "mpMax"), false, "an onlooker must never receive the number");
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
