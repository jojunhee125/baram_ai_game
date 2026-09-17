import type { Pool } from "pg";
import { markDatabaseDegraded, markDatabaseOk } from "./status";

/**
 * One account's spendable balance (r04-settlement.md §4 D1, §5 schema). A
 * dedicated table rather than reusing `inventory_item`'s `copper-coin` row or a column on
 * `player_progress` — the design's own reasoning: a currency row shares neither
 * `inventory_item`'s `MAX_DISTINCT_ITEMS` cap nor its `equipped_slot`, and a currency lock must
 * not contend with the EXP lock `player_progress` already carries on the same hunting path.
 *
 * Keyed by the SSO `sub`, `ProgressStore`'s own convention. D2/D3 (the reward ledger and its
 * `settle()` transaction) are a later milestone — nothing in this codebase calls `credit` or
 * `debit` yet.
 */
export interface CurrencyStore {
  /** Never credited yet is `0`, not `null` — a balance always has a spendable value, unlike EXP's "not yet leveled" absence. */
  getBalance(ownerKey: string): Promise<number>;

  /**
   * Adds `amount` and answers the balance afterwards — a single UPSERT, `ProgressStore.grantExp`'s
   * own reason: two overlapping credits for the same account (two tabs, or two fire-and-forget
   * grants racing) must not lose one to a read-modify-write.
   */
  credit(ownerKey: string, amount: number): Promise<number>;

  /**
   * Subtracts `amount` and answers the balance afterwards, or `null` when the account cannot
   * afford it — insufficient balance is a result, not a fault, `InventoryStore.add`'s own "a full
   * bag is not an exception" convention. A single conditional UPDATE, so the balance check and the
   * spend it gates can never straddle a race against a concurrent credit or debit on the same row.
   */
  debit(ownerKey: string, amount: number): Promise<number | null>;
}

/**
 * The store a server booted without `DATABASE_URL` runs on. Not a test double: it is the normal
 * local-development path (`ProgressStore`'s own reason), which is what keeps the server test
 * suite running without a Postgres to point it at.
 */
export class InMemoryCurrencyStore implements CurrencyStore {
  private readonly balanceByOwner = new Map<string, number>();

  getBalance(ownerKey: string): Promise<number> {
    return Promise.resolve(this.balanceByOwner.get(ownerKey) ?? 0);
  }

  credit(ownerKey: string, amount: number): Promise<number> {
    // Same guard `PostgresCurrencyStore.credit` applies — see `assertPositiveAmount`'s own doc
    // comment — so the two implementations of this interface agree on a non-positive-integer
    // amount instead of only one of them catching it, live, in production.
    try {
      assertPositiveAmount(amount);
    } catch (cause) {
      return Promise.reject(cause as Error);
    }
    const total = (this.balanceByOwner.get(ownerKey) ?? 0) + amount;
    this.balanceByOwner.set(ownerKey, total);
    return Promise.resolve(total);
  }

  debit(ownerKey: string, amount: number): Promise<number | null> {
    try {
      assertPositiveAmount(amount);
    } catch (cause) {
      return Promise.reject(cause as Error);
    }
    const balance = this.balanceByOwner.get(ownerKey) ?? 0;
    if (balance < amount) {
      return Promise.resolve(null);
    }
    const next = balance - amount;
    this.balanceByOwner.set(ownerKey, next);
    return Promise.resolve(next);
  }

  /**
   * A synchronous peek at the live balance — `getBalance`'s own answer, without the `Promise`
   * wrapper. `InMemorySettlementStore` (`settlementStore.ts`) is the one caller: composing
   * `credit`/`debit` there would put an `await` between its idempotency check and the write that
   * follows it, which is exactly the race two concurrent `settle()` calls for one `grantKey` must
   * not have. Reading and writing this way keeps this store the single owner of every account's
   * balance instead of `InMemorySettlementStore` keeping a second, divergent copy — the local
   * dev/test path would otherwise disagree with itself about what an account is holding.
   */
  peekBalance(ownerKey: string): number {
    return this.balanceByOwner.get(ownerKey) ?? 0;
  }

  /** The write half of {@link peekBalance} — same caller, same reason. */
  pokeBalance(ownerKey: string, balance: number): void {
    this.balanceByOwner.set(ownerKey, balance);
  }
}

export class PostgresCurrencyStore implements CurrencyStore {
  /**
   * `Pick<Pool, "query">` rather than `Pool` itself: D3's `settle()` transaction (not built yet,
   * design §6 R04-a) will construct this over a checked-out `PoolClient` instead of the pool, so
   * the same `credit`/`debit` statements run inside its `BEGIN`/`COMMIT`. `PoolClient.query` has
   * the same shape as `Pool.query`, so narrowing to just that method is what lets both be passed
   * here without this store caring which one it got.
   */
  constructor(private readonly executor: Pick<Pool, "query">) {}

  async getBalance(ownerKey: string): Promise<number> {
    assertUuidOwnerKey(ownerKey);
    const result = await this.query<{ balance: string }>(
      "SELECT balance FROM player_currency WHERE owner_key = $1",
      [ownerKey],
    );
    const row = result.rows[0];
    return row === undefined ? 0 : toSafeInteger(row.balance);
  }

  async credit(ownerKey: string, amount: number): Promise<number> {
    assertPositiveAmount(amount);
    assertUuidOwnerKey(ownerKey);
    // One statement, `PostgresProgressStore.grantExp`'s own upsert shape: two tabs of the same
    // account crediting at once cannot interleave a read and a write and lose one grant.
    const result = await this.query<{ balance: string }>(
      `INSERT INTO player_currency (owner_key, balance)
       VALUES ($1, $2)
       ON CONFLICT (owner_key)
       DO UPDATE SET balance = player_currency.balance + EXCLUDED.balance, updated_at = now()
       RETURNING balance`,
      [ownerKey, amount],
    );
    const balance = result.rows[0]?.balance;
    return balance === undefined ? amount : toSafeInteger(balance);
  }

  async debit(ownerKey: string, amount: number): Promise<number | null> {
    assertPositiveAmount(amount);
    assertUuidOwnerKey(ownerKey);
    // The `balance >= $2` guard reads and writes the live column in one statement, so a debit can
    // never observe a balance that a concurrent credit or debit on the same row is still in
    // flight to change. No matching row — never credited, or insufficient — returns zero rows,
    // which is what turns "cannot afford it" into a result instead of a race the caller must
    // guard against with a separate read first.
    const result = await this.query<{ balance: string }>(
      `UPDATE player_currency
       SET balance = balance - $2, updated_at = now()
       WHERE owner_key = $1 AND balance >= $2
       RETURNING balance`,
      [ownerKey, amount],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSafeInteger(row.balance);
  }

  /**
   * Every query reports what it learned about the connection: `/api/health` has no other way to
   * notice that a database which answered at boot has stopped answering. Failures are re-thrown —
   * the caller decides what a failed call means, and here it means the credit or debit is dropped
   * rather than the room inventing a number.
   */
  private async query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    try {
      const result = await this.executor.query<T>(sql, [...values]);
      markDatabaseOk();
      return result;
    } catch (cause) {
      markDatabaseDegraded(cause);
      throw cause;
    }
  }
}

/**
 * `player_currency.balance` is `bigint`, which the driver hands back as a decimal string. A bare
 * `Number()` past `Number.MAX_SAFE_INTEGER` silently rounds to the nearest representable float —
 * confirmed against a real Postgres 16: crediting an even amount onto the odd
 * `Number.MAX_SAFE_INTEGER` produces the true value `9007199254740993`, which `Number()` rounds to
 * `9007199254740992`. `bigint` is not the fix here: `credit`/`debit`'s return value ends up inside
 * `SettlementOutcome` (`settlementStore.ts`), which is persisted as `reward_grant.result` jsonb,
 * and `JSON.stringify` throws outright on a `bigint` — changing this return type would break the
 * one consumer this precision check exists to protect. A balance this large has no legitimate
 * reason to exist in this game's economy (it is many orders of magnitude past anything `credit`'s
 * positive-integer amounts could accumulate in a account's lifetime), so reaching one is itself a
 * bug — a manual DB edit, or a caller looping `credit` unbounded — worth surfacing loudly rather
 * than reporting a silently wrong number forever.
 */
function toSafeInteger(rawBalance: string): number {
  const value = BigInt(rawBalance);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(
      `currency balance ${rawBalance} is outside Number's safe integer range — this should be unreachable in this game's economy`,
    );
  }
  return Number(value);
}

/**
 * Rejects what the schema itself would reject, before either implementation acts on it —
 * `inventoryStore.ts`'s own `assertGrantableQuantity` and `progressStore.ts`'s own
 * `assertGrantableAmount`, for the same reason: without this the two implementations disagree on
 * a non-positive amount instead of both refusing it identically. Shared by `credit` and `debit`
 * rather than split in two: neither operation means anything for a zero, negative or fractional
 * amount, and `player_currency.balance` is declared `bigint`, not `numeric`.
 */
function assertPositiveAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new TypeError(`currency amount must be a positive integer, not ${amount}`);
  }
}

/**
 * The same shape `inventoryStore.ts`'s own `assertUuidOwnerKey` enforces, and for the same
 * reason: a caller falls back to the session id when there is no SSO identity (local
 * development), and a session id is never the uuid `owner_key` is declared as. Left unguarded, a
 * production room with no SSO for a session would throw a driver-level `22P02` that
 * {@link PostgresCurrencyStore.query} cannot tell apart from a dropped connection, marking
 * `/api/health` degraded on every such call.
 */
function assertUuidOwnerKey(ownerKey: string): void {
  if (!UUID_PATTERN.test(ownerKey)) {
    throw new TypeError(`currency owner key must be a uuid, not "${ownerKey}"`);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
