import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Direction,
  MONSTER_TICK_MS,
  PLAYER_ATTACK_DAMAGE,
  cumulativeExpForLevel,
  levelForExp,
  type JoinOptions,
  type TilePosition,
} from "@zep-test/shared";
import type { ProgressStore } from "../db/progressStore";
import type { RoomCreateOptions } from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";
import { MonsterKind, type MonsterSpawnDefinition, type MonsterType } from "./monsterDefinitions";

/**
 * Regression coverage for the concurrency risk the W-1 implementer self-reported ("the session
 * cache's floor parameter can be inaccurate under an extreme race") and the team lead asked to
 * verify (docs/implementation-2026-09-11-level-system-w1.md "남은 한계").
 *
 * The scenario: `awardExp` (from a kill) and `applyDeathExpPenalty` (from that same session dying)
 * are both fire-and-forget (`void this...`, metaverseRoom.ts) and both round-trip to the store.
 * In real Postgres, nothing guarantees `applyDeathPenalty`'s UPDATE runs before `grantExp`'s UPSERT
 * commits, or that `grantExp`'s JS promise resolves before `applyDeathExpPenalty`'s does — the two
 * are separate statements on separate round trips. This file drives that interleaving directly
 * (bypassing the room's own scheduling, which cannot control DB round-trip order) to confirm the
 * fix: `MetaverseRoom.queueProgressUpdate` now serializes every store call for one account, so the
 * room always applies them in the order they were *issued* regardless of which one's DB round trip
 * happens to answer first.
 */

const OPEN_CENTRE: TilePosition = { tileX: 78, tileY: 70 };

const EMPTY_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
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
      expReward: 1,
      loot: [],
    },
  ],
]);

class VerifyRoom extends MetaverseRoom {
  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return [{ id: "inert", room: ROOM_OPTIONS.roomType, kind: MonsterKind.Squirrel, at: { tileX: 0, tileY: 0 }, wanderRadiusTiles: 0 }];
  }
  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return EMPTY_TYPES;
  }
  override setSimulationInterval(): void {
    // hand-driven, exactly as levelSystem.test.ts's own harness
  }
}

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "verify-level-race",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
};

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null; ssoUserId: string | null };
  userData?: { lastAttackAt: number; hp: number; lastDamagedAt: number; totalExp: number; ownerKey: string | null };
  sent: Array<{ type: string; payload: unknown }>;
}

function fakeClient(sessionId: string, ssoUserId: string | null): FakeClient {
  const sent: FakeClient["sent"] = [];
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

function join(room: MetaverseRoom, sessionId: string, ssoUserId: string | null, options?: Partial<JoinOptions>): FakeClient {
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
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function createRoom(overrides: Partial<RoomCreateOptions> = {}): Promise<VerifyRoom> {
  const room = new VerifyRoom();
  await room.onCreate({ ...ROOM_OPTIONS, ...overrides });
  return room;
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

/**
 * Models the two store calls as genuinely independent round trips: `grantExp` commits to the
 * "live" ledger the instant it's called (as a real UPSERT commits independently of when its
 * caller notices the response), but its *promise* only resolves when the test calls
 * `releaseGrant()` — standing in for network/pool latency on that one connection.
 * `applyDeathPenalty` reads/writes the same live ledger synchronously and resolves immediately,
 * standing in for a second connection that happens to answer faster.
 */
class RacingProgressStore implements ProgressStore {
  private live = 0;
  private pendingGrantTotal: number | null = null;
  private releaseGrantFn: (() => void) | null = null;

  seed(exp: number): void {
    this.live = exp;
  }

  getExp(_ownerKey: string): Promise<number | null> {
    return Promise.resolve(this.live);
  }

  grantExp(_ownerKey: string, amount: number): Promise<number> {
    this.live += amount;
    const total = this.live;
    return new Promise((resolve) => {
      this.pendingGrantTotal = total;
      this.releaseGrantFn = () => resolve(total);
    });
  }

  /** Lets the in-flight grantExp's promise resolve now, after other work has already run. */
  releaseGrant(): void {
    const release = this.releaseGrantFn;
    assert.ok(release, "expected a pending grantExp to release");
    this.releaseGrantFn = null;
    this.pendingGrantTotal = null;
    release();
  }

  applyDeathPenalty(_ownerKey: string, floor: number): Promise<number | null> {
    const next = Math.max(floor, this.live - Math.round(this.live * 0.01));
    this.live = next;
    return Promise.resolve(next);
  }

  liveExp(): number {
    return this.live;
  }
}

describe("VERIFY W-1 fix: awardExp and applyDeathExpPenalty for the same account are serialized", () => {
  it("applies a kill and the same session's immediately following death in the order they happened, never the order their DB round trips resolve", async () => {
    const store = new RacingProgressStore();
    const room = await createRoom({ progressStore: store });
    try {
      const owner = "owner-race";
      const client = join(room, "victim", owner);
      place(room, "victim", OPEN_CENTRE);
      assert.ok(client.userData);

      // Precondition: currently level 9, one EXP short of leveling to 10, and the store's live
      // ledger already agrees (this is what a real hydrateProgressCache would have produced).
      const floor9 = cumulativeExpForLevel(9);
      const threshold10 = cumulativeExpForLevel(10);
      assert.ok(
        Math.round(threshold10 * 0.01) >= 1,
        "precondition: level 10's threshold is large enough that a 1% cut is not rounded to 0",
      );
      const preKillExp = threshold10 - 1;
      client.userData.totalExp = preKillExp;
      store.seed(preKillExp);
      assert.equal(levelForExp(preKillExp), 9, "precondition: level 9 before the kill");

      // The kill overshoots into level 10 by more than a death's 1% cut, so the death penalty
      // below has visible room to bite without a rounding edge case hiding it.
      const overshoot = Math.max(50, Math.round(threshold10 * 0.05));
      assert.ok(
        threshold10 + overshoot < cumulativeExpForLevel(11),
        "precondition: the overshoot chosen still lands within level 10, not level 11",
      );
      const grantAmount = overshoot + 1;
      const postKillExp = preKillExp + grantAmount;
      assert.equal(postKillExp, threshold10 + overshoot);

      const player = room.state.players.get("victim");
      assert.ok(player);
      player.level = 9;

      // 1) The killing blow fires awardExp. Its `grantExp` round trip does not resolve until this
      //    test calls `releaseGrant()` below (modeling network/pool latency on that one round trip).
      const lastHit = { sessionId: "victim", ownerKey: owner };
      const awardExpPromise = room["awardExp"](lastHit, "m", grantAmount, 1000);

      // 2) Before that promise resolves, the same session dies (a second monster's queued attack
      //    landing the same tick is an entirely ordinary way for this to happen under load).
      //    `MetaverseRoom.queueProgressUpdate` has already queued this behind the still in-flight
      //    grant for this same account, so it cannot run — and this promise cannot settle — until
      //    the grant ahead of it finishes.
      const realSession = room["clientsBySession"].get("victim")?.userData;
      assert.ok(realSession);
      const deathPenaltyPromise = room["applyDeathExpPenalty"]("victim", realSession);
      await flush();

      // The store's own ledger already reflects the kill — `grantExp` commits the instant it is
      // called, exactly as a real UPSERT would — but nothing downstream of that pending promise has
      // run yet: the session cache, `Player.level`, and the queued death penalty are all still
      // waiting on the same round trip.
      assert.equal(store.liveExp(), postKillExp, "the store's live ledger already moved");
      assert.equal(client.userData.totalExp, preKillExp, "the session cache has not moved yet");
      assert.equal(player.level, 9, "Player.level has not moved yet either");

      // 3) The grant's round trip finally returns. `RacingProgressStore.applyDeathPenalty` never
      //    blocks on anything of its own, so the queued death penalty runs to completion the
      //    instant the grant ahead of it does — there is no observable gap to inspect in between,
      //    only the guarantee that it *cannot* start any earlier. Awaiting `deathPenaltyPromise`
      //    below (which is chained behind, and therefore also waits for, the grant) is enough to
      //    wait for both.
      store.releaseGrant();
      await awardExpPromise;

      // 4) The death penalty that was queued behind the grant now runs — and computes its floor
      //    from the account's *current* level 10, not the stale level 9 it would have used had
      //    `applyDeathExpPenalty` been free to race ahead of the grant instead of waiting its turn.
      await deathPenaltyPromise;
      await flush();

      const clampedByDeathPenalty = store.liveExp();
      assert.ok(clampedByDeathPenalty < postKillExp, "the death penalty still cuts 1% off the just-earned total");
      assert.ok(
        clampedByDeathPenalty >= threshold10,
        "floored at level 10's own minimum — the death happened after the kill, never before it",
      );
      assert.ok(
        clampedByDeathPenalty > floor9,
        "nowhere near level 9's much lower floor, which a stale read would have wrongly used",
      );

      assert.equal(
        client.userData.totalExp,
        clampedByDeathPenalty,
        "the session cache reflects the store's own, correctly floored answer",
      );
      // Design §11.0: a death costs progress within a level but never the level itself, so
      // Player.level is untouched by the penalty above.
      assert.equal(player.level, 10);

      const storeTruth = await store.getExp(owner);
      assert.equal(storeTruth, clampedByDeathPenalty, "the store's own ledger matches what the session cache was set to");
      // The invariant contracts.ts's own doc comment for `PlayerSession.totalExp` states:
      // "`Player.level` ... is always `levelForExp(totalExp)` — never a second value kept in step
      // by hand." That now holds even after this race — including across a reconnect, since
      // `hydrateProgressCache` would read this same, already-correct store value.
      assert.equal(
        levelForExp(storeTruth ?? -1),
        player.level,
        "the store's real, persisted level agrees with the broadcast Player.level",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY ProgressStore contract: InMemoryProgressStore vs PostgresProgressStore agree on invalid grantExp amounts", () => {
  it("InMemoryProgressStore now rejects the same non-positive-integer amounts PostgresProgressStore always has", async () => {
    const { InMemoryProgressStore } = await import("../db/progressStore");
    const store = new InMemoryProgressStore();

    // PostgresProgressStore.grantExp rejects (assertGrantableAmount) for any of these — see
    // progressStore.ts's own `assertGrantableAmount`, now shared by both implementations of the
    // same `ProgressStore` interface, so invalid input is caught identically in local testing
    // (in-memory) and production (Postgres) instead of only the latter.
    await assert.rejects(() => store.grantExp("owner-x", -5), /positive integer/, "a negative grant is rejected");
    await assert.rejects(() => store.grantExp("owner-y", 0), /positive integer/, "a zero grant is rejected");
    await assert.rejects(() => store.grantExp("owner-z", 0.5), /positive integer/, "a non-integer grant is rejected");

    // Rejecting must not have left a partial write behind.
    assert.equal(await store.getExp("owner-x"), null);
    assert.equal(await store.getExp("owner-y"), null);
    assert.equal(await store.getExp("owner-z"), null);
  });
});
