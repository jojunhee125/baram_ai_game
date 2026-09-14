import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cumulativeExpForLevel, levelForExp } from "@zep-test/shared";
import { CachedProgressStore } from "./progressCache";
import type { ProgressStore } from "./progressStore";

/**
 * Phase W-2a (`docs/design-phase-w2-level-client.md` §1.2, §1.6, §3.2): `CachedProgressStore` is
 * the seam that lets grand-plaza show real levels (`docs/decisions.md` 2026-09-11) without paying a
 * query on every join — this file verifies the decorator directly, against a stub inner store, at a
 * finer grain than the room-level coverage in `rooms/levelSystem.test.ts` (cross-room cache hits)
 * and `rooms/levelSystem-raceCondition.test.ts` (the same-account kill/death ordering guarantee,
 * reproduced here too, directly against the cache, in "recomputes the death penalty floor...").
 */

/** A `ProgressStore` double that counts calls and can hold `getExp` open on demand. */
class DeferredStubStore implements ProgressStore {
  getExpCalls = 0;
  grantExpCalls = 0;
  applyDeathPenaltyCalls = 0;
  private readonly exp = new Map<string, number>();
  private readonly heldGetExp: Array<() => void> = [];
  private holding = false;

  seed(ownerKey: string, value: number): void {
    this.exp.set(ownerKey, value);
  }

  /** Every `getExp` call issued from now on parks until {@link releaseHeldGetExp} is called. */
  holdGetExp(): void {
    this.holding = true;
  }

  releaseHeldGetExp(): void {
    this.holding = false;
    const waiting = this.heldGetExp.splice(0);
    for (const resume of waiting) {
      resume();
    }
  }

  async getExp(ownerKey: string): Promise<number | null> {
    this.getExpCalls += 1;
    if (this.holding) {
      await new Promise<void>((resolve) => this.heldGetExp.push(resolve));
    }
    return this.exp.get(ownerKey) ?? null;
  }

  async grantExp(ownerKey: string, amount: number): Promise<number> {
    this.grantExpCalls += 1;
    const total = (this.exp.get(ownerKey) ?? 0) + amount;
    this.exp.set(ownerKey, total);
    return total;
  }

  async applyDeathPenalty(ownerKey: string, floor: number): Promise<number | null> {
    this.applyDeathPenaltyCalls += 1;
    const current = this.exp.get(ownerKey);
    if (current === undefined) {
      return null;
    }
    const next = Math.max(floor, current - Math.round(current * 0.01));
    this.exp.set(ownerKey, next);
    return next;
  }
}

it("account progress only notifies successful writes and isolates subscriber failures", async (context) => {
  context.mock.method(console, "warn", () => {});
  const inner = new DeferredStubStore();
  const cache = new CachedProgressStore(inner);
  const events: number[] = [];
  cache.subscribe("owner-events", () => { throw new Error("subscriber failed"); });
  const unsubscribe = cache.subscribe("owner-events", (total) => events.push(total));
  const grant = inner.grantExp.bind(inner);
  inner.grantExp = () => Promise.reject(new Error("write failed"));
  await assert.rejects(cache.grantExp("owner-events", 10), /write failed/);
  assert.deepEqual(events, []);
  inner.grantExp = grant;
  assert.equal(await cache.grantExp("owner-events", 10), 10);
  assert.deepEqual(events, [10]);
  unsubscribe();
  await cache.grantExp("owner-events", 10);
  assert.deepEqual(events, [10]);
});

it("recovers the owner queue after handled read and grant failures", async () => {
  const inner = new DeferredStubStore();
  let rejectRead = true;
  let rejectGrant = true;
  const cache = new CachedProgressStore({
    getExp: (ownerKey) => {
      if (rejectRead) {
        rejectRead = false;
        return Promise.reject(new Error("read unavailable"));
      }
      return inner.getExp(ownerKey);
    },
    grantExp: (ownerKey, amount) => {
      if (rejectGrant) {
        rejectGrant = false;
        return Promise.reject(new Error("grant unavailable"));
      }
      return inner.grantExp(ownerKey, amount);
    },
    applyDeathPenalty: (ownerKey, floor) => inner.applyDeathPenalty(ownerKey, floor),
  });

  await assert.rejects(cache.getExp("owner-retry"), /read unavailable/);
  assert.equal(await cache.getExp("owner-retry"), null);
  const rejectedGrant = assert.rejects(cache.grantExp("owner-retry", 10), /grant unavailable/);
  const nextGrant = cache.grantExp("owner-retry", 7);
  await rejectedGrant;
  assert.equal(await nextGrant, 7);
  assert.equal(await cache.getExp("owner-retry"), 7);
  await tick();
});

/** Resolves after two macrotask turns — enough for other queued callers to also reach `acquire()`. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A `ProgressStore` double that caps how many `getExp` calls may be actually running at once —
 * `db/pool.ts`'s own `max: 4`, modeled as a FIFO wait queue rather than a real `pg.Pool` (nothing
 * in this process can safely fake a real connection). Used to check the cold-start burst
 * (`db/pool.ts`'s own comment on `max`) against a genuine bottleneck, not just "many concurrent
 * calls succeed" — a queue-of-1 store would never prove the CachedProgressStore side survives
 * *contention*.
 */
class PooledStubStore implements ProgressStore {
  getExpCalls = 0;
  private readonly exp = new Map<string, number>();
  private inFlight = 0;
  private peak = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  seed(ownerKey: string, value: number): void {
    this.exp.set(ownerKey, value);
  }

  /** The most callers this store ever actually ran at the same time — must never exceed the cap. */
  get peakConcurrency(): number {
    return this.peak;
  }

  async getExp(ownerKey: string): Promise<number | null> {
    this.getExpCalls += 1;
    await this.acquire();
    try {
      // A tiny, deterministic stand-in for a round trip — long enough (in macrotask turns, not
      // wall-clock time) for every other caller queued behind this one to also reach `acquire()`
      // before this one releases its slot, so the queue actually has to do its job.
      await tick();
      await tick();
      return this.exp.get(ownerKey) ?? null;
    } finally {
      this.release();
    }
  }

  async grantExp(): Promise<number> {
    throw new Error("not exercised by the pool-contention test");
  }

  async applyDeathPenalty(): Promise<number | null> {
    throw new Error("not exercised by the pool-contention test");
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      this.peak = Math.max(this.peak, this.inFlight);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.inFlight += 1;
        this.peak = Math.max(this.peak, this.inFlight);
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    this.waiting.shift()?.();
  }
}

describe("VERIFY CachedProgressStore — a per-owner read-through/write-through mirror (design-phase-w2-level-client.md §1.2)", () => {
  it("calls the inner store at most once per owner: one cold miss, then pure cache hits", async () => {
    const inner = new DeferredStubStore();
    inner.seed("owner-a", 500);
    const cache = new CachedProgressStore(inner);

    assert.equal(await cache.getExp("owner-a"), 500);
    assert.equal(await cache.getExp("owner-a"), 500);
    assert.equal(await cache.getExp("owner-a"), 500);
    assert.equal(inner.getExpCalls, 1, "one cold miss, then repeated hits");
  });

  it("caches a confirmed *never-granted* answer too, so a fresh account is also only ever asked once", async () => {
    const inner = new DeferredStubStore();
    const cache = new CachedProgressStore(inner);

    assert.equal(await cache.getExp("owner-fresh"), null);
    assert.equal(await cache.getExp("owner-fresh"), null);
    assert.equal(inner.getExpCalls, 1, "null is a cached answer, not a permanent cache miss");
  });

  it("merges concurrent cold-miss getExp calls for the same owner into one inner call", async () => {
    const inner = new DeferredStubStore();
    inner.seed("owner-b", 42);
    inner.holdGetExp();
    const cache = new CachedProgressStore(inner);

    const first = cache.getExp("owner-b");
    const second = cache.getExp("owner-b");
    const third = cache.getExp("owner-b");
    inner.releaseHeldGetExp();

    assert.deepEqual(await Promise.all([first, second, third]), [42, 42, 42]);
    assert.equal(inner.getExpCalls, 1, "three concurrent cold misses collapse into one inner read");
  });

  it("keeps different owners' cold misses independent — neither queue blocks the other", async () => {
    const inner = new DeferredStubStore();
    inner.seed("owner-c", 1);
    inner.seed("owner-d", 2);
    const cache = new CachedProgressStore(inner);

    const [c, d] = await Promise.all([cache.getExp("owner-c"), cache.getExp("owner-d")]);
    assert.equal(c, 1);
    assert.equal(d, 2);
    assert.equal(inner.getExpCalls, 2, "two distinct accounts really are two reads, not a shared one");
  });

  /**
   * `db/pool.ts`'s own `max: 4` is the real upper bound this class's callers actually contend
   * for — so the burst has to be modeled against a genuinely 4-wide bottleneck, not an
   * unbounded stub that would pass even if every request ran at once. `POOL_SIZE` below is that
   * same number; if `pool.ts`'s `max` ever changes, update it here too so this test keeps
   * modeling the real ceiling rather than a stale one.
   */
  it("survives a cold-start burst of many distinct accounts contending for a 4-wide pool — none lost, none stuck", async () => {
    const ACCOUNTS = 500; // CCU-scale, design-phase-w2-level-client.md §1.6's cold-boot burst
    const POOL_SIZE = 4; // db/pool.ts's own `max`
    const inner = new PooledStubStore(POOL_SIZE);
    for (let index = 0; index < ACCOUNTS; index++) {
      inner.seed(`owner-${index}`, index);
    }
    const cache = new CachedProgressStore(inner);

    // All 500 arrive before any of them has been served, exactly as a post-redeploy join burst
    // would — every one of these is a different account, so `CachedProgressStore`'s own per-owner
    // queue never serializes any of them against each other; only the pool's width does.
    const gets = Array.from({ length: ACCOUNTS }, (_, index) => cache.getExp(`owner-${index}`));
    const results = await Promise.all(gets);

    assert.deepEqual(
      results,
      Array.from({ length: ACCOUNTS }, (_, index) => index),
      "every account still gets its own correct answer despite queueing behind the pool — none lost",
    );
    assert.equal(inner.getExpCalls, ACCOUNTS, "one inner call per distinct account, no duplicate or dropped call");
    assert.equal(
      inner.peakConcurrency,
      POOL_SIZE,
      "the burst actually saturated and queued behind the pool's own width, not merely run under it",
    );
  });

  it("grantExp's answer is trusted outright and mirrored into the cache — no read-back needed", async () => {
    const inner = new DeferredStubStore();
    const cache = new CachedProgressStore(inner);

    assert.equal(await cache.grantExp("owner-e", 10), 10);
    assert.equal(await cache.getExp("owner-e"), 10, "the grant already warmed the cache");
    assert.equal(inner.getExpCalls, 0, "getExp never had to ask the inner store at all");
    assert.equal(inner.grantExpCalls, 1);
  });

  it("applyDeathPenalty's answer is trusted outright and mirrored into the cache", async () => {
    const inner = new DeferredStubStore();
    inner.seed("owner-f", 1000);
    const cache = new CachedProgressStore(inner);

    assert.equal(await cache.applyDeathPenalty("owner-f", 0), 990);
    assert.equal(await cache.getExp("owner-f"), 990);
    assert.equal(inner.getExpCalls, 0);
  });

  it("caches a null applyDeathPenalty answer (no such account) the same way getExp would", async () => {
    const inner = new DeferredStubStore();
    const cache = new CachedProgressStore(inner);

    assert.equal(await cache.applyDeathPenalty("owner-none", 0), null);
    assert.equal(await cache.getExp("owner-none"), null);
    assert.equal(inner.getExpCalls, 0, "the earlier null answer was cached, not merely discarded");
  });

  /**
   * The regression `levelSystem-raceCondition.test.ts` guards at the room level, reproduced here
   * directly against the cache: a kill (`grantExp`) and that same account's death
   * (`applyDeathPenalty`) can be *issued* back-to-back in one tick, before the grant's own round
   * trip has returned. The room computes `applyDeathPenalty`'s `floor` argument from its own
   * session state at the moment it issues the call — before the queued grant ahead of it has had
   * any chance to matter — so that argument can describe a level the account has already leveled
   * past by the time this call's turn in the per-owner queue actually arrives. `applyDeathPenalty`
   * must not trust a stale `floor`: it is expected to recompute against its own cache once the
   * grant ahead of it has landed there.
   */
  it("recomputes the death penalty floor from a same-owner grant queued just ahead of it, not the caller's stale argument", async () => {
    const inner = new DeferredStubStore();
    const floor9 = cumulativeExpForLevel(9);
    const threshold10 = cumulativeExpForLevel(10);
    const preKillExp = threshold10 - 1;
    inner.seed("owner-race", preKillExp);
    const cache = new CachedProgressStore(inner);
    // Warms the cache to preKillExp first (a real room's join-time hydrate would have done this).
    assert.equal(await cache.getExp("owner-race"), preKillExp);

    const overshoot = Math.max(50, Math.round(threshold10 * 0.05));
    assert.ok(
      threshold10 + overshoot < cumulativeExpForLevel(11),
      "precondition: the overshoot chosen still lands within level 10, not level 11",
    );
    const grantAmount = overshoot + 1;

    // Issued back-to-back, exactly as `MetaverseRoom.awardExp`/`applyDeathExpPenalty` would for a
    // kill and a death landing in the same tick — neither `await`s before the other starts.
    const grantPromise = cache.grantExp("owner-race", grantAmount);
    const staleFloor = floor9; // what the room would have computed before the grant landed
    const penaltyPromise = cache.applyDeathPenalty("owner-race", staleFloor);

    const total = await grantPromise;
    assert.equal(total, preKillExp + grantAmount);
    assert.equal(levelForExp(total), 10, "precondition: the grant really did cross into level 10");

    const result = await penaltyPromise;
    assert.ok(
      result !== null && result >= threshold10,
      "floored at level 10's own minimum, not the stale level-9 floor the caller passed in",
    );
    assert.equal(await cache.getExp("owner-race"), result, "the cache reflects the store's own answer");
  });

  it("falls back to the caller's own floor when nothing fresher is cached yet", async () => {
    const inner = new DeferredStubStore();
    inner.seed("owner-g", 1000);
    const cache = new CachedProgressStore(inner);

    // No `getExp`/`grantExp` warmed the cache first — this is the very first call for this owner.
    const result = await cache.applyDeathPenalty("owner-g", 500);
    assert.equal(result, 990, "990 > the passed floor of 500, so the floor never actually engaged");
  });
});
