import { cumulativeExpForLevel, levelForExp } from "@zep-test/shared";
import type { ProgressStore } from "./progressStore";

/**
 * A process-scoped read-through/write-through mirror over a `ProgressStore`
 * (design-phase-w2-level-client.md §1 — "레벨은 grand-plaza를 포함한 모든 room에서 실제 값이 보여야
 * 한다", `docs/decisions.md` 2026-09-11). `index.ts` creates exactly one of these wrapping the real
 * store (Postgres or in-memory) and hands the result to every `gameServer.define()` call in the
 * same place `progressStore` already went (`server.ts:103-110`) — `contracts.ts`/`server.ts` do not
 * change at all, because every room already shared that one reference before this class existed
 * (§1.0): this only intercepts what was already the single shared seam.
 *
 * Why join no longer costs grand-plaza a query except once per account, ever, for the life of the
 * process: `getExp` answers from `exp` (a plain per-owner map) the instant an account has been seen
 * once, and nothing ever evicts an entry — see §1.4 for why that is safe at this project's scale.
 * `exp` caches a confirmed *never-granted* answer (the inner store's `null`) exactly the same as a
 * confirmed number: without that, an account that has never killed anything would take the cold-miss
 * path forever, on every join, in every room — the "once, ever" claim would only hold for accounts
 * that already have a row. `Map#has` is what makes that distinguishable from "not yet asked" at all,
 * since a plain `Map#get` cannot tell "absent" apart from "present and null" on a `V | null` value.
 *
 * Why the W-1 per-account queue moved here (`MetaverseRoom.queueProgressUpdate`, now deleted —
 * §1.2): the queue's job is "every store call for one account, from whichever room instance issued
 * it, executes in the order it was issued" — W-1 only needed that within one room instance because
 * grand-plaza never touched the store at all. W-2 makes grand-plaza call `getExp` too, which opens
 * a cross-room-instance version of the same race (one tab in grand-plaza, another in a hunting room,
 * same account) that a per-room queue cannot see. Moving the queue to this class — constructed once,
 * shared by every room definition — extends the same guarantee to "from whichever room instance,"
 * which is a superset of what W-1 guaranteed, never a narrower one: nothing that was serialized
 * before stops being serialized now.
 */
export class CachedProgressStore implements ProgressStore {
  /**
   * The last value this process has confirmed for an account — `null` is a confirmed answer too
   * (this account has never been granted anything), not "unknown"; see the class doc above and
   * {@link getExp}. Never evicted — see class doc §1.4.
   */
  private readonly exp = new Map<string, number | null>();
  /** Tail of the in-flight chain per account, the exact shape `MetaverseRoom.queueProgressUpdate` had. */
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(private readonly inner: ProgressStore) {}

  /**
   * A cache hit is a synchronous `Map.has`/`Map.get` pair wrapped in `Promise.resolve` — it does
   * not touch the queue at all, so it can never wait behind an unrelated in-flight grant or penalty
   * for the same account. A cache miss does go through the queue: two concurrent joins that both
   * miss (a fresh account opening two tabs at once, or two rooms racing to hydrate the same account
   * on process start) must not fire two `inner.getExp` calls, and queuing the miss is what lets the
   * second one see the first one's answer already sitting in `exp` (the `fromCache` re-check below)
   * instead of issuing a redundant read.
   */
  getExp(ownerKey: string): Promise<number | null> {
    if (this.exp.has(ownerKey)) {
      // The cast is safe: `has` already confirmed an entry exists, even though the value it holds
      // may itself be `null` — `Map#get`'s own return type cannot express that narrowing.
      return Promise.resolve(this.exp.get(ownerKey) as number | null);
    }
    return this.enqueue(ownerKey, async () => {
      if (this.exp.has(ownerKey)) {
        return this.exp.get(ownerKey) as number | null;
      }
      const value = await this.inner.getExp(ownerKey);
      this.exp.set(ownerKey, value);
      return value;
    });
  }

  /** The store's own answer is trusted outright and mirrored into the cache — `awardExp`'s own rule. */
  grantExp(ownerKey: string, amount: number): Promise<number> {
    return this.enqueue(ownerKey, async () => {
      const total = await this.inner.grantExp(ownerKey, amount);
      this.exp.set(ownerKey, total);
      return total;
    });
  }

  /**
   * `floor` arrives computed by the caller (`MetaverseRoom.applyDeathExpPenalty`) from whatever
   * level its own session-side bookkeeping believes the account is at *when it issues this call* —
   * which is not necessarily this call's actual turn in the per-account queue above. A kill and that
   * same session's death landing in the same tick issue a `grantExp` and this call back-to-back,
   * before the grant's own round trip (and the room's `session.totalExp` update that follows it)
   * has happened; the room's `floor` argument was computed before any of that, so it can describe a
   * level the account has already leveled past by the time this task actually runs (this is exactly
   * the race `levelSystem-raceCondition.test.ts` exists to catch — see
   * `docs/implementation-2026-09-11-level-visibility-w2a.md` for why the design sketch this class is
   * modeled on cannot be implemented literally without reopening it).
   *
   * Fixed by re-deriving the floor from `exp` once this task's turn actually arrives: any `grantExp`
   * queued ahead of this call for the same owner has already written its answer into `exp` by the
   * time its own task resolves (the `.then()` this closure is chained onto only fires after that),
   * so `exp.get(ownerKey)` here is always at least as fresh as whatever the room could have known
   * when it made this call. Taking the higher of the two floors is what makes this safe in both
   * directions: nothing recorded yet, or a confirmed-zero account, falls back to the caller's own
   * floor unchanged (cumulativeExpForLevel of a zero total is 0, which can never raise a floor that
   * is already non-negative), and a fresher, higher floor never gets overridden by a caller argument
   * computed too early.
   */
  applyDeathPenalty(ownerKey: string, floor: number): Promise<number | null> {
    return this.enqueue(ownerKey, async () => {
      const known = this.exp.has(ownerKey) ? (this.exp.get(ownerKey) as number | null) : undefined;
      const effectiveFloor =
        known === undefined || known === null
          ? floor
          : Math.max(floor, cumulativeExpForLevel(levelForExp(known)));
      const result = await this.inner.applyDeathPenalty(ownerKey, effectiveFloor);
      // Mirrored unconditionally, including `null`: a `null` here means the inner store confirms
      // this account has no row at all, which is exactly the same confirmed answer `getExp` caches.
      this.exp.set(ownerKey, result);
      return result;
    });
  }

  /**
   * Exactly `MetaverseRoom.queueProgressUpdate`'s old body, moved rather than rewritten — see that
   * method's former doc comment (`levelSystem-raceCondition.test.ts`) for why chaining onto the
   * previous link, whatever it settles to, is what fixes call order to match issue order regardless
   * of which round trip actually answers first.
   */
  private enqueue<T>(ownerKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(ownerKey) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queue.set(ownerKey, next);
    const cleanup = () => {
      // Only the entry this task itself installed may be cleared — a task that queued behind it
      // while it was running must keep the map pointed at its own, later link.
      if (this.queue.get(ownerKey) === next) {
        this.queue.delete(ownerKey);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}
