import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type Pool as PgPool } from "pg";
import {
  InMemoryCurrencyStore,
  PostgresCurrencyStore,
  type CurrencyStore,
} from "./currencyStore";
import { runMigrations } from "./migrate";
import { getDatabaseStatus, resetDatabaseStatus } from "./status";

/**
 * R04-a (`docs/r04-settlement.md` §4 D1, §5 schema): the two `CurrencyStore`
 * implementations answer the same questions, `progressStore.test.ts`'s own reason for its pair —
 * the in-memory one is not a test double but the path local development and this whole suite
 * actually run on, so a contract that drifts between them is only found in production.
 */
const OWNER = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const OTHER_OWNER = "f1e2d3c4-b5a6-4789-9876-543210fedcba";

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
}

/** The narrow slice of `pg.Pool` the store touches — `progressStore.test.ts`'s own stub. */
function stubPool(
  respond: (sql: string, values: readonly unknown[]) => { rows: Record<string, unknown>[] },
): { pool: PgPool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query(sql: string, values: readonly unknown[]) {
      queries.push({ sql, values });
      try {
        return Promise.resolve(respond(sql, values));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  } as unknown as PgPool;
  return { pool, queries };
}

/** A stand-in Postgres: one row per owner key, driven by the store's own SQL. */
function inMemoryBackedPostgresStore(): CurrencyStore {
  const rows = new Map<string, bigint>();
  const { pool } = stubPool((sql, values) => {
    const ownerKey = String(values[0]);
    if (sql.includes("SELECT")) {
      const balance = rows.get(ownerKey);
      return { rows: balance === undefined ? [] : [{ balance: balance.toString() }] };
    }
    const amount = BigInt(Number(values[1]));
    if (sql.includes("INSERT")) {
      // INSERT ... ON CONFLICT DO UPDATE SET balance = balance + EXCLUDED.balance
      const total = (rows.get(ownerKey) ?? 0n) + amount;
      rows.set(ownerKey, total);
      return { rows: [{ balance: total.toString() }] };
    }
    // UPDATE ... WHERE owner_key = $1 AND balance >= $2 — no matching row is no row returned.
    const current = rows.get(ownerKey) ?? 0n;
    if (current < amount) {
      return { rows: [] };
    }
    const next = current - amount;
    rows.set(ownerKey, next);
    return { rows: [{ balance: next.toString() }] };
  });
  return new PostgresCurrencyStore(pool);
}

function assertCurrencyStoreContract(label: string, create: () => CurrencyStore): void {
  describe(`CurrencyStore contract — ${label}`, () => {
    it("answers 0 for an account that has never been credited anything", async () => {
      assert.equal(await create().getBalance(OWNER), 0);
    });

    it("returns what was credited", async () => {
      const store = create();
      assert.equal(await store.credit(OWNER, 4), 4);
      assert.equal(await store.getBalance(OWNER), 4);
    });

    it("adds rather than overwrites across repeated credits", async () => {
      const store = create();
      await store.credit(OWNER, 4);
      await store.credit(OWNER, 7);
      await store.credit(OWNER, 11);
      assert.equal(await store.getBalance(OWNER), 22);
    });

    it("keeps two accounts apart", async () => {
      const store = create();
      await store.credit(OWNER, 4);
      await store.credit(OTHER_OWNER, 600);
      assert.equal(await store.getBalance(OWNER), 4);
      assert.equal(await store.getBalance(OTHER_OWNER), 600);
    });

    it("settles every one of 25 concurrent credits without losing one", async () => {
      const store = create();
      await Promise.all(Array.from({ length: 25 }, () => store.credit(OWNER, 4)));
      assert.equal(await store.getBalance(OWNER), 100);
    });

    it("debits down to the amount available", async () => {
      const store = create();
      await store.credit(OWNER, 100);
      assert.equal(await store.debit(OWNER, 30), 70);
      assert.equal(await store.getBalance(OWNER), 70);
    });

    it("answers null and changes nothing when the balance cannot cover the debit", async () => {
      const store = create();
      await store.credit(OWNER, 10);
      assert.equal(await store.debit(OWNER, 11), null);
      assert.equal(await store.getBalance(OWNER), 10);
    });

    it("answers null for a debit against an account that has never been credited", async () => {
      const store = create();
      assert.equal(await store.debit(OWNER, 1), null);
      assert.equal(await store.getBalance(OWNER), 0);
    });

    it("debits exactly to zero without going negative", async () => {
      const store = create();
      await store.credit(OWNER, 5);
      assert.equal(await store.debit(OWNER, 5), 0);
      assert.equal(await store.getBalance(OWNER), 0);
    });

    it("rejects a non-positive-integer amount on both credit and debit", async () => {
      const store = create();
      await store.credit(OWNER, 10);
      for (const amount of [0, -1, 1.5, Number.NaN]) {
        await assert.rejects(() => store.credit(OWNER, amount), TypeError, `credit ${amount}`);
        await assert.rejects(() => store.debit(OWNER, amount), TypeError, `debit ${amount}`);
      }
    });
  });
}

assertCurrencyStoreContract("InMemoryCurrencyStore", () => new InMemoryCurrencyStore());
assertCurrencyStoreContract("PostgresCurrencyStore", inMemoryBackedPostgresStore);

describe("InMemoryCurrencyStore", () => {
  it("keeps nothing across instances, so a restart looks like a fresh account", async () => {
    const first = new InMemoryCurrencyStore();
    await first.credit(OWNER, 4);
    assert.equal(await new InMemoryCurrencyStore().getBalance(OWNER), 0);
  });

  it("never touches the database status field", async () => {
    resetDatabaseStatus();
    const store = new InMemoryCurrencyStore();
    await store.credit(OWNER, 4);
    await store.getBalance(OWNER);
    await store.debit(OWNER, 1);
    assert.equal(getDatabaseStatus(), "disabled", "the no-database mode must stay 'disabled'");
  });
});

describe("PostgresCurrencyStore — the statements it sends", () => {
  beforeEach(resetDatabaseStatus);

  it("reads one row by owner key and nothing else", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ balance: "42" }] }));
    assert.equal(await new PostgresCurrencyStore(pool).getBalance(OWNER), 42);
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? "", /SELECT balance FROM player_currency WHERE owner_key = \$1/);
    assert.deepEqual(queries[0]?.values, [OWNER]);
  });

  it("credits with a single upsert, so two tabs of one account cannot interleave a read and a write", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ balance: "4" }] }));
    await new PostgresCurrencyStore(pool).credit(OWNER, 4);
    assert.equal(queries.length, 1, "read-modify-write would be two statements");
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /INSERT INTO player_currency/);
    assert.match(sql, /ON CONFLICT \(owner_key\)/);
    assert.match(sql, /DO UPDATE SET balance = player_currency\.balance \+ EXCLUDED\.balance/);
    assert.deepEqual(queries[0]?.values, [OWNER, 4]);
  });

  it("debits with a single conditional update guarded by the live balance", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ balance: "1" }] }));
    await new PostgresCurrencyStore(pool).debit(OWNER, 9);
    assert.equal(queries.length, 1, "a separate balance check first would race a concurrent debit");
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /UPDATE player_currency/);
    assert.match(sql, /WHERE owner_key = \$1 AND balance >= \$2/);
    assert.deepEqual(queries[0]?.values, [OWNER, 9]);
  });

  it("rejects a non-uuid owner key rather than sending it to Postgres as one", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [] }));
    const store = new PostgresCurrencyStore(pool);
    await assert.rejects(() => store.getBalance("session-abc"), /must be a uuid/);
    await assert.rejects(() => store.credit("session-abc", 4), /must be a uuid/);
    await assert.rejects(() => store.debit("session-abc", 4), /must be a uuid/);
    assert.equal(queries.length, 0, "the guard must fire before any query is sent");
  });

  it("rejects a non-positive-integer amount", async () => {
    const store = new PostgresCurrencyStore(stubPool(() => ({ rows: [] })).pool);
    for (const amount of [0, -1, 1.5]) {
      await assert.rejects(() => store.credit(OWNER, amount), /positive integer/);
      await assert.rejects(() => store.debit(OWNER, amount), /positive integer/);
    }
  });
});

describe("PostgresCurrencyStore — health reporting", () => {
  beforeEach(resetDatabaseStatus);

  it("marks the database ok on a successful read, credit and debit", async () => {
    const { pool } = stubPool(() => ({ rows: [{ balance: "10" }] }));
    const store = new PostgresCurrencyStore(pool);
    await store.getBalance(OWNER);
    assert.equal(getDatabaseStatus(), "ok");
    resetDatabaseStatus();
    await store.credit(OWNER, 4);
    assert.equal(getDatabaseStatus(), "ok");
    resetDatabaseStatus();
    await store.debit(OWNER, 4);
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database degraded and rethrows when a query fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(
      () => new PostgresCurrencyStore(pool).getBalance(OWNER),
      /connection terminated/,
      "the caller decides what a failed read means; the store must not swallow it",
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });
});

/**
 * Opt-in against a real Postgres, `progressStore.test.ts`'s own convention — this is what proves
 * `0008_player_currency.sql` is valid DDL and that the upsert/debit statements really are atomic
 * under concurrent writers, neither of which a synchronous stub can show.
 *
 *   docker run -d --rm --name zep-currency-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=zeptest \
 *     -p 55442:5432 postgres:17-alpine
 *   ZEP_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55442/zeptest npm test -w @zep-test/server
 *
 * NOT executed in this implementation session — no Docker/Postgres was reachable in the sandbox
 * this store was implemented in (see the implementation record). The block is written and ready;
 * it will run the moment `ZEP_TEST_DATABASE_URL` is set.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

describe(
  "PostgresCurrencyStore — against a real server",
  { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false },
  () => {
    let pool: Pool;

    before(async () => {
      pool = new Pool({ connectionString: REAL_DATABASE_URL, max: 8 });
      // Applies 0001..0008; a broken 0008_player_currency.sql fails the whole suite right here.
      await runMigrations(pool);
      resetDatabaseStatus();
    });

    after(async () => {
      await pool.end();
      resetDatabaseStatus();
    });

    // `inventoryStore.test.ts`'s own `ownerScopedStore`: the shared contract's `OWNER`/`OTHER_OWNER`
    // constants become a fresh uuid *per logical key*, not one uuid for the whole store. A single
    // `randomUUID()` shared by every call — what this file had before — makes `OWNER` and
    // `OTHER_OWNER` collide onto the same real row, so "keeps two accounts apart" credits one row
    // twice instead of two rows once, and every later `it` in this contract also piles onto
    // whatever `OWNER` accumulated in the ones before it since they all reuse the same table.
    assertCurrencyStoreContract("PostgresCurrencyStore on a real server", () => {
      const inner = new PostgresCurrencyStore(pool);
      const owners = new Map<string, string>();
      const resolve = (ownerKey: string): string => {
        let mapped = owners.get(ownerKey);
        if (mapped === undefined) {
          mapped = randomUUID();
          owners.set(ownerKey, mapped);
        }
        return mapped;
      };
      return {
        getBalance: (ownerKey) => inner.getBalance(resolve(ownerKey)),
        credit: (ownerKey, amount) => inner.credit(resolve(ownerKey), amount),
        debit: (ownerKey, amount) => inner.debit(resolve(ownerKey), amount),
      };
    });

    it("loses nothing when 16 concurrent credits race on one row", async () => {
      const store = new PostgresCurrencyStore(pool);
      const ownerKey = randomUUID();
      await Promise.all(Array.from({ length: 16 }, () => store.credit(ownerKey, 10)));
      assert.equal(await store.getBalance(ownerKey), 160);
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM player_currency WHERE owner_key = $1",
        [ownerKey],
      );
      assert.equal(rows.rows[0]?.count, "1", "the PK must collapse concurrent upserts onto one row");
    });

    it("stores balance as bigint, not as text or a bare integer", async () => {
      const store = new PostgresCurrencyStore(pool);
      const ownerKey = randomUUID();
      await store.credit(ownerKey, 4);
      const typed = await pool.query<{ type: string }>(
        `SELECT pg_typeof(balance)::text AS type FROM player_currency WHERE owner_key = $1`,
        [ownerKey],
      );
      assert.equal(typed.rows[0]?.type, "bigint");
    });
  },
);
