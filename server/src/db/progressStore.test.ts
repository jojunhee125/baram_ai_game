import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type Pool as PgPool } from "pg";
import { runMigrations } from "./migrate";
import {
  InMemoryProgressStore,
  PostgresProgressStore,
  type ProgressStore,
} from "./progressStore";
import { getDatabaseStatus, resetDatabaseStatus } from "./status";

/**
 * Phase W-1 (`docs/design-phase-w-level-system.md` §5, §11.0): the two `ProgressStore`
 * implementations answer the same questions, for the reason `profileStore.test.ts` states about
 * its own pair — the in-memory one is not a test double but the path local development and this
 * whole suite actually run on, so a contract that drifts between them is only found in production.
 */
const OWNER = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const OTHER_OWNER = "f1e2d3c4-b5a6-4789-9876-543210fedcba";

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
}

/** The narrow slice of `pg.Pool` the store touches — `profileStore.test.ts`'s own stub. */
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
function inMemoryBackedPostgresStore(): ProgressStore {
  const rows = new Map<string, bigint>();
  const { pool } = stubPool((sql, values) => {
    const ownerKey = String(values[0]);
    if (sql.includes("SELECT")) {
      const exp = rows.get(ownerKey);
      return { rows: exp === undefined ? [] : [{ exp: exp.toString() }] };
    }
    if (sql.includes("GREATEST")) {
      const floor = BigInt(Number(values[1]));
      const current = rows.get(ownerKey) ?? 0n;
      const cut = BigInt(Math.round(Number(current) * 0.01));
      const next = current - cut > floor ? current - cut : floor;
      if (current === 0n) {
        // No row: an UPDATE against a key with no row affects nothing, `RETURNING` gives nothing.
        return { rows: [] };
      }
      rows.set(ownerKey, next);
      return { rows: [{ exp: next.toString() }] };
    }
    // INSERT ... ON CONFLICT DO UPDATE SET exp = exp + EXCLUDED.exp
    const amount = BigInt(Number(values[1]));
    const total = (rows.get(ownerKey) ?? 0n) + amount;
    rows.set(ownerKey, total);
    return { rows: [{ exp: total.toString() }] };
  });
  return new PostgresProgressStore(pool);
}

function assertProgressStoreContract(label: string, create: () => ProgressStore): void {
  describe(`ProgressStore contract — ${label}`, () => {
    it("answers null for an account that has never been granted anything", async () => {
      assert.equal(await create().getExp(OWNER), null);
    });

    it("returns what was granted", async () => {
      const store = create();
      assert.equal(await store.grantExp(OWNER, 4), 4);
      assert.equal(await store.getExp(OWNER), 4);
    });

    it("adds rather than overwrites across repeated grants", async () => {
      const store = create();
      await store.grantExp(OWNER, 4);
      await store.grantExp(OWNER, 7);
      await store.grantExp(OWNER, 11);
      assert.equal(await store.getExp(OWNER), 22);
    });

    it("keeps two accounts apart", async () => {
      const store = create();
      await store.grantExp(OWNER, 4);
      await store.grantExp(OTHER_OWNER, 600);
      assert.equal(await store.getExp(OWNER), 4);
      assert.equal(await store.getExp(OTHER_OWNER), 600);
    });

    it("settles every one of 25 concurrent grants without losing one", async () => {
      const store = create();
      await Promise.all(Array.from({ length: 25 }, () => store.grantExp(OWNER, 4)));
      assert.equal(await store.getExp(OWNER), 100);
    });

    it("floors the death penalty at the given level threshold rather than cutting past it", async () => {
      const store = create();
      await store.grantExp(OWNER, 100);
      // 1% of 100 is 1, so an ordinary cut would land on 99 — but a floor of 100 (the account is
      // already sitting exactly on its level's minimum) must not let the cut go below it.
      const result = await store.applyDeathPenalty(OWNER, 100);
      assert.equal(result, 100);
      assert.equal(await store.getExp(OWNER), 100);
    });

    it("cuts 1%, rounded, when the floor allows it", async () => {
      const store = create();
      await store.grantExp(OWNER, 1000);
      const result = await store.applyDeathPenalty(OWNER, 0);
      assert.equal(result, 990, "1000 - round(1000 * 0.01) = 990");
    });

    it("answers null and changes nothing for an account with no row at all", async () => {
      const store = create();
      assert.equal(await store.applyDeathPenalty(OWNER, 0), null);
      assert.equal(await store.getExp(OWNER), null);
    });
  });
}

assertProgressStoreContract("InMemoryProgressStore", () => new InMemoryProgressStore());
assertProgressStoreContract("PostgresProgressStore", inMemoryBackedPostgresStore);

describe("InMemoryProgressStore", () => {
  it("keeps nothing across instances, so a restart looks like a fresh account", async () => {
    const first = new InMemoryProgressStore();
    await first.grantExp(OWNER, 4);
    assert.equal(await new InMemoryProgressStore().getExp(OWNER), null);
  });

  it("never touches the database status field", async () => {
    resetDatabaseStatus();
    const store = new InMemoryProgressStore();
    await store.grantExp(OWNER, 4);
    await store.getExp(OWNER);
    await store.applyDeathPenalty(OWNER, 0);
    assert.equal(getDatabaseStatus(), "disabled", "the no-database mode must stay 'disabled'");
  });
});

describe("PostgresProgressStore — the statements it sends", () => {
  beforeEach(resetDatabaseStatus);

  it("reads one row by owner key and nothing else", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ exp: "42" }] }));
    assert.equal(await new PostgresProgressStore(pool).getExp(OWNER), 42);
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? "", /SELECT exp FROM player_progress WHERE owner_key = \$1/);
    assert.deepEqual(queries[0]?.values, [OWNER]);
  });

  it("grants with a single upsert, so two tabs of one account cannot interleave a read and a write", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ exp: "4" }] }));
    await new PostgresProgressStore(pool).grantExp(OWNER, 4);
    assert.equal(queries.length, 1, "read-modify-write would be two statements");
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /INSERT INTO player_progress/);
    assert.match(sql, /ON CONFLICT \(owner_key\)/);
    assert.match(sql, /DO UPDATE SET exp = player_progress\.exp \+ EXCLUDED\.exp/);
    assert.deepEqual(queries[0]?.values, [OWNER, 4]);
  });

  it("applies the death penalty with a single atomic statement against the live column", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ exp: "99" }] }));
    await new PostgresProgressStore(pool).applyDeathPenalty(OWNER, 50);
    assert.equal(queries.length, 1, "read-then-write would race a concurrent grant on the same row");
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /UPDATE player_progress/);
    assert.match(sql, /GREATEST\(\$2::bigint, exp - ROUND\(exp \* 0\.01\)\)/);
    assert.deepEqual(queries[0]?.values, [OWNER, 50]);
  });

  it("rejects a non-uuid owner key rather than sending it to Postgres as one", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [] }));
    const store = new PostgresProgressStore(pool);
    await assert.rejects(() => store.getExp("session-abc"), /must be a uuid/);
    await assert.rejects(() => store.grantExp("session-abc", 4), /must be a uuid/);
    await assert.rejects(() => store.applyDeathPenalty("session-abc", 0), /must be a uuid/);
    assert.equal(queries.length, 0, "the guard must fire before any query is sent");
  });

  it("rejects a non-positive-integer grant amount", async () => {
    const store = new PostgresProgressStore(stubPool(() => ({ rows: [] })).pool);
    for (const amount of [0, -1, 1.5]) {
      await assert.rejects(() => store.grantExp(OWNER, amount), /positive integer/);
    }
  });
});

describe("PostgresProgressStore — health reporting", () => {
  beforeEach(resetDatabaseStatus);

  it("marks the database ok on a successful read, grant and penalty", async () => {
    const { pool } = stubPool(() => ({ rows: [{ exp: "0" }] }));
    const store = new PostgresProgressStore(pool);
    await store.getExp(OWNER);
    assert.equal(getDatabaseStatus(), "ok");
    resetDatabaseStatus();
    await store.grantExp(OWNER, 4);
    assert.equal(getDatabaseStatus(), "ok");
    resetDatabaseStatus();
    await store.applyDeathPenalty(OWNER, 0);
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database degraded and rethrows when a query fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(
      () => new PostgresProgressStore(pool).getExp(OWNER),
      /connection terminated/,
      "the caller decides what a failed read means; the store must not swallow it",
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });
});

/**
 * Opt-in against a real Postgres, `bossStateStore.test.ts`'s own convention — this is what proves
 * `0006_player_progress.sql` is valid DDL and that the UPSERT/penalty statements really are atomic
 * under concurrent writers, neither of which a synchronous stub can show.
 *
 *   docker run -d --rm --name zep-progress-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=zeptest \
 *     -p 55442:5432 postgres:17-alpine
 *   ZEP_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55442/zeptest npm test -w @zep-test/server
 *
 * NOT executed in this implementation session — no Docker/Postgres was reachable in the sandbox
 * this Phase was implemented in (see the implementation record). The block is written and ready;
 * it will run the moment `ZEP_TEST_DATABASE_URL` is set.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

describe(
  "PostgresProgressStore — against a real server",
  { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false },
  () => {
    let pool: Pool;

    before(async () => {
      pool = new Pool({ connectionString: REAL_DATABASE_URL, max: 8 });
      // Applies 0001..0006; a broken 0006_player_progress.sql fails the whole suite right here.
      await runMigrations(pool);
      resetDatabaseStatus();
    });

    after(async () => {
      await pool.end();
      resetDatabaseStatus();
    });

    assertProgressStoreContract("PostgresProgressStore on a real server", () => {
      const inner = new PostgresProgressStore(pool);
      const ownerKey = randomUUID();
      return {
        getExp: () => inner.getExp(ownerKey),
        grantExp: (_owner, amount) => inner.grantExp(ownerKey, amount),
        applyDeathPenalty: (_owner, floor) => inner.applyDeathPenalty(ownerKey, floor),
      };
    });

    it("loses nothing when 16 concurrent grants race on one row", async () => {
      const store = new PostgresProgressStore(pool);
      const ownerKey = randomUUID();
      await Promise.all(Array.from({ length: 16 }, () => store.grantExp(ownerKey, 10)));
      assert.equal(await store.getExp(ownerKey), 160);
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM player_progress WHERE owner_key = $1",
        [ownerKey],
      );
      assert.equal(rows.rows[0]?.count, "1", "the PK must collapse concurrent upserts onto one row");
    });

    it("stores exp as bigint, not as text or a bare integer", async () => {
      const store = new PostgresProgressStore(pool);
      const ownerKey = randomUUID();
      await store.grantExp(ownerKey, 4);
      const typed = await pool.query<{ type: string }>(
        `SELECT pg_typeof(exp)::text AS type FROM player_progress WHERE owner_key = $1`,
        [ownerKey],
      );
      assert.equal(typed.rows[0]?.type, "bigint");
    });
  },
);
