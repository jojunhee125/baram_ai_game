import type { Pool } from "pg";
import { markDatabaseDegraded, markDatabaseOk } from "./status";

export type ProgressListener = (totalExp: number, reason: "grant" | "penalty") => void;

/**
 * One account's cumulative EXP (design-phase-w-level-system.md §5.1). Level is always derived
 * from this via `levelForExp` (`@zep-test/shared`, `leveling.ts`) — no `level` column exists here,
 * on purpose, so a curve or cap change reinterprets every stored row instead of needing a
 * migration or a recompute pass.
 *
 * Keyed by the SSO `sub`, `ProfileStore`'s own convention.
 */
export interface ProgressStore {
  /** Observes committed writes in account order; no initial snapshot. Returns an unsubscribe function. */
  subscribe?(ownerKey: string, listener: ProgressListener): () => void;

  /** Never granted yet is `null` — the store invents no default; callers treat that as exp 0 / level 1. */
  getExp(ownerKey: string): Promise<number | null>;

  /**
   * Adds `amount` and answers the account's total afterwards — a single UPSERT, `InventoryStore
   * .add`'s own reason: two overlapping kills for the same account (two tabs, or two fire-and-
   * forget grants racing) must not lose one to a read-modify-write.
   */
  grantExp(ownerKey: string, amount: number): Promise<number>;

  /**
   * The death penalty (design §11.0): cuts 1% of accumulated EXP, floored at `floor` — the
   * minimum EXP for the level the caller already knows the account was at the moment it died, so a
   * death can never cost a level, only progress within one.
   *
   * `floor` travels in rather than being recomputed here: level is a pure function of `exp`, and
   * this call already reads and writes `exp` live in one statement, so recomputing a level from a
   * value read separately (and possibly stale by the time this executes) would be exactly the
   * second copy of "level" design §5.1 exists to rule out. Passing the threshold in keeps this one
   * round trip, atomic against a concurrent grant on the same row.
   *
   * Answers `null`, changing nothing, for an account that has never been granted any EXP — 1% of
   * zero is zero, so there is nothing to floor and nothing to write.
   */
  applyDeathPenalty(ownerKey: string, floor: number): Promise<number | null>;
}

/**
 * The store a server booted without `DATABASE_URL` runs on. Not a test double: it is the normal
 * local-development path (`ProfileStore`'s own reason), which is what keeps the server test suite
 * running without a Postgres to point it at.
 */
export class InMemoryProgressStore implements ProgressStore {
  private readonly expByOwner = new Map<string, number>();

  getExp(ownerKey: string): Promise<number | null> {
    return Promise.resolve(this.expByOwner.get(ownerKey) ?? null);
  }

  grantExp(ownerKey: string, amount: number): Promise<number> {
    // Same guard `PostgresProgressStore.grantExp` applies — see `assertGrantableAmount`'s own doc
    // comment — so the two implementations of this interface agree on a non-positive-integer
    // amount instead of only one of them catching it, live, in production.
    try {
      assertGrantableAmount(amount);
    } catch (cause) {
      return Promise.reject(cause as Error);
    }
    const total = (this.expByOwner.get(ownerKey) ?? 0) + amount;
    this.expByOwner.set(ownerKey, total);
    return Promise.resolve(total);
  }

  applyDeathPenalty(ownerKey: string, floor: number): Promise<number | null> {
    const exp = this.expByOwner.get(ownerKey);
    if (exp === undefined) {
      return Promise.resolve(null);
    }
    const next = Math.max(floor, exp - Math.round(exp * 0.01));
    this.expByOwner.set(ownerKey, next);
    return Promise.resolve(next);
  }
}

export class PostgresProgressStore implements ProgressStore {
  constructor(private readonly pool: Pool) {}

  async getExp(ownerKey: string): Promise<number | null> {
    assertUuidOwnerKey(ownerKey);
    const result = await this.query<{ exp: string }>(
      "SELECT exp FROM player_progress WHERE owner_key = $1",
      [ownerKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : Number(row.exp);
  }

  async grantExp(ownerKey: string, amount: number): Promise<number> {
    assertGrantableAmount(amount);
    assertUuidOwnerKey(ownerKey);
    // One statement, `profileStore.ts`'s own upsert shape: two tabs of the same account hunting
    // at once cannot interleave a read and a write and lose one grant.
    const result = await this.query<{ exp: string }>(
      `INSERT INTO player_progress (owner_key, exp)
       VALUES ($1, $2)
       ON CONFLICT (owner_key)
       DO UPDATE SET exp = player_progress.exp + EXCLUDED.exp, updated_at = now()
       RETURNING exp`,
      [ownerKey, amount],
    );
    return Number(result.rows[0]?.exp ?? amount);
  }

  async applyDeathPenalty(ownerKey: string, floor: number): Promise<number | null> {
    assertUuidOwnerKey(ownerKey);
    // GREATEST keeps the floor and the 1% cut in one atomic statement against the *live* column —
    // no read-modify-write, so a grantExp racing this on the same row can never be clobbered by a
    // penalty computed from a stale snapshot (see this method's own doc comment on the interface).
    const result = await this.query<{ exp: string }>(
      `UPDATE player_progress
       SET exp = GREATEST($2::bigint, exp - ROUND(exp * 0.01)), updated_at = now()
       WHERE owner_key = $1
       RETURNING exp`,
      [ownerKey, floor],
    );
    const row = result.rows[0];
    return row === undefined ? null : Number(row.exp);
  }

  /**
   * Every query reports what it learned about the connection: `/api/health` has no other way to
   * notice that a database which answered at boot has stopped answering. Failures are re-thrown —
   * the caller decides what a failed call means, and here it means the grant or penalty is
   * dropped rather than the room inventing a number.
   */
  private async query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    try {
      const result = await this.pool.query<T>(sql, [...values]);
      markDatabaseOk();
      return result;
    } catch (cause) {
      markDatabaseDegraded(cause);
      throw cause;
    }
  }
}

/**
 * Rejects what the schema itself would reject, before either implementation acts on it —
 * `inventoryStore.ts`'s own `assertGrantableQuantity`, for the same reason: without this the two
 * implementations disagree on a non-positive amount instead of both refusing it identically.
 */
function assertGrantableAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new TypeError(`exp grant amount must be a positive integer, not ${amount}`);
  }
}

/**
 * The same shape `inventoryStore.ts`'s own `assertUuidOwnerKey` enforces, and for the same
 * reason: `MetaverseRoom.awardExp` falls back to the session id when there is no SSO identity
 * (local development), and a session id is never the uuid `owner_key` is declared as. Left
 * unguarded, a production room with no SSO for a session would throw a driver-level `22P02` that
 * {@link PostgresProgressStore.query} cannot tell apart from a dropped connection, marking
 * `/api/health` degraded on every such kill.
 */
function assertUuidOwnerKey(ownerKey: string): void {
  if (!UUID_PATTERN.test(ownerKey)) {
    throw new TypeError(`progress owner key must be a uuid, not "${ownerKey}"`);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
