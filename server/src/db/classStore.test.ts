import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type Pool as PgPool } from "pg";
import { InMemoryClassStore, PostgresClassStore, type ClassStore } from "./classStore";
import { runMigrations } from "./migrate";
import { getDatabaseStatus, resetDatabaseStatus } from "./status";

/**
 * R05-a (`docs/r05-classes-and-skills.md` D1): the two `ClassStore` implementations answer the
 * same questions, `currencyStore.test.ts`'s own reason for its pair — the in-memory one is not a
 * test double but the path local development and this whole suite actually run on, so a contract
 * that drifts between them is only found in production.
 */
const OWNER = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const OTHER_OWNER = "f1e2d3c4-b5a6-4789-9876-543210fedcba";

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
}

/** The narrow slice of `pg.Pool` the store touches — `currencyStore.test.ts`'s own stub. */
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
function inMemoryBackedPostgresStore(): ClassStore {
  const rows = new Map<string, string>();
  const { pool } = stubPool((sql, values) => {
    const ownerKey = String(values[0]);
    if (sql.includes("SELECT")) {
      const classKey = rows.get(ownerKey);
      return { rows: classKey === undefined ? [] : [{ class_key: classKey }] };
    }
    // INSERT ... ON CONFLICT DO UPDATE SET class_key = player_class.class_key RETURNING class_key
    const requested = String(values[1]);
    const stored = rows.get(ownerKey) ?? requested;
    rows.set(ownerKey, stored);
    return { rows: [{ class_key: stored }] };
  });
  return new PostgresClassStore(pool);
}

function assertClassStoreContract(label: string, create: () => ClassStore): void {
  describe(`ClassStore contract — ${label}`, () => {
    it("answers null for an account that has never chosen", async () => {
      assert.equal(await create().getClass(OWNER), null);
    });

    it("returns what was chosen", async () => {
      const store = create();
      assert.equal(await store.chooseOnce(OWNER, "warrior"), "warrior");
      assert.equal(await store.getClass(OWNER), "warrior");
    });

    it("keeps two accounts apart", async () => {
      const store = create();
      await store.chooseOnce(OWNER, "warrior");
      await store.chooseOnce(OTHER_OWNER, "cleric");
      assert.equal(await store.getClass(OWNER), "warrior");
      assert.equal(await store.getClass(OTHER_OWNER), "cleric");
    });

    it("chooseOnce twice with different keys returns the first key both times and leaves one row", async () => {
      const store = create();
      assert.equal(await store.chooseOnce(OWNER, "rogue"), "rogue");
      assert.equal(await store.chooseOnce(OWNER, "shaman"), "rogue", "the store never overwrites");
      assert.equal(await store.getClass(OWNER), "rogue");
    });

    it("re-choosing the same class is a no-op that still answers it", async () => {
      const store = create();
      await store.chooseOnce(OWNER, "cleric");
      assert.equal(await store.chooseOnce(OWNER, "cleric"), "cleric");
    });

    it("rejects an invalid class key on both getClass's caller path and chooseOnce, before storing anything", async () => {
      const store = create();
      await assert.rejects(() => store.chooseOnce(OWNER, "wizard"), TypeError);
      assert.equal(await store.getClass(OWNER), null, "the invalid attempt must not have been stored");
    });
  });
}

assertClassStoreContract("InMemoryClassStore", () => new InMemoryClassStore());
assertClassStoreContract("PostgresClassStore", inMemoryBackedPostgresStore);

describe("InMemoryClassStore", () => {
  it("keeps nothing across instances, so a restart looks like a fresh account", async () => {
    const first = new InMemoryClassStore();
    await first.chooseOnce(OWNER, "warrior");
    assert.equal(await new InMemoryClassStore().getClass(OWNER), null);
  });

  it("never touches the database status field", async () => {
    resetDatabaseStatus();
    const store = new InMemoryClassStore();
    await store.chooseOnce(OWNER, "warrior");
    await store.getClass(OWNER);
    assert.equal(getDatabaseStatus(), "disabled", "the no-database mode must stay 'disabled'");
  });
});

describe("PostgresClassStore — the statements it sends", () => {
  beforeEach(resetDatabaseStatus);

  it("reads one row by owner key and nothing else", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ class_key: "warrior" }] }));
    assert.equal(await new PostgresClassStore(pool).getClass(OWNER), "warrior");
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? "", /SELECT class_key FROM player_class WHERE owner_key = \$1/);
    assert.deepEqual(queries[0]?.values, [OWNER]);
  });

  it("chooses with a single upsert, so two tabs racing a first choice cannot each believe they won", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ class_key: "rogue" }] }));
    await new PostgresClassStore(pool).chooseOnce(OWNER, "rogue");
    assert.equal(queries.length, 1, "read-then-write would be two statements");
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /INSERT INTO player_class/);
    assert.match(sql, /ON CONFLICT \(owner_key\)/);
    assert.match(sql, /DO UPDATE SET class_key = player_class\.class_key/);
    assert.deepEqual(queries[0]?.values, [OWNER, "rogue"]);
  });

  it("rejects a non-uuid owner key rather than sending it to Postgres as one", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [] }));
    const store = new PostgresClassStore(pool);
    await assert.rejects(() => store.getClass("session-abc"), /must be a uuid/);
    await assert.rejects(() => store.chooseOnce("session-abc", "warrior"), /must be a uuid/);
    assert.equal(queries.length, 0, "the guard must fire before any query is sent");
  });

  it("rejects an invalid class key before touching the database", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [] }));
    await assert.rejects(
      () => new PostgresClassStore(pool).chooseOnce(OWNER, "wizard"),
      /warrior\/rogue\/shaman\/cleric/,
    );
    assert.equal(queries.length, 0);
  });
});

describe("PostgresClassStore — health reporting", () => {
  beforeEach(resetDatabaseStatus);

  it("marks the database ok on a successful read and choice", async () => {
    const { pool } = stubPool(() => ({ rows: [{ class_key: "warrior" }] }));
    const store = new PostgresClassStore(pool);
    await store.getClass(OWNER);
    assert.equal(getDatabaseStatus(), "ok");
    resetDatabaseStatus();
    await store.chooseOnce(OWNER, "warrior");
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database degraded and rethrows when a query fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(
      () => new PostgresClassStore(pool).getClass(OWNER),
      /connection terminated/,
      "the caller decides what a failed read means; the store must not swallow it",
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });
});

/**
 * Opt-in against a real Postgres, `currencyStore.test.ts`'s own convention — this is what proves
 * `0011_player_class.sql` is valid DDL and that the upsert really is atomic under concurrent
 * first-choosers, neither of which a synchronous stub can show.
 *
 *   docker run -d --rm --name zep-class-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=zeptest \
 *     -p 55442:5432 postgres:17-alpine
 *   ZEP_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55442/zeptest npm test -w @zep-test/server
 *
 * NOT executed in this implementation session — no Docker/Postgres was reachable here. The block
 * is written and ready; it runs the moment `ZEP_TEST_DATABASE_URL` is set.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

describe(
  "PostgresClassStore — against a real server",
  { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false },
  () => {
    let pool: Pool;

    before(async () => {
      pool = new Pool({ connectionString: REAL_DATABASE_URL, max: 8 });
      // Applies 0001..0011; a broken 0011_player_class.sql fails the whole suite right here.
      await runMigrations(pool);
      resetDatabaseStatus();
    });

    after(async () => {
      await pool.end();
      resetDatabaseStatus();
    });

    // `currencyStore.test.ts`'s own `resolve`: the shared contract's `OWNER`/`OTHER_OWNER`
    // constants become a fresh uuid per logical key, not one uuid for the whole store, so this
    // contract's own accounts never collide onto the same real row across its `it`s.
    assertClassStoreContract("PostgresClassStore on a real server", () => {
      const inner = new PostgresClassStore(pool);
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
        getClass: (ownerKey) => inner.getClass(resolve(ownerKey)),
        chooseOnce: (ownerKey, classKey) => inner.chooseOnce(resolve(ownerKey), classKey),
      };
    });

    it("collapses 16 concurrent first-choosers onto one row and one winning class", async () => {
      const store = new PostgresClassStore(pool);
      const ownerKey = randomUUID();
      const classKeys = ["warrior", "rogue", "shaman", "cleric"];
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, index) => store.chooseOnce(ownerKey, classKeys[index % 4] as string)),
      );
      const winner = results[0];
      assert.ok(results.every((result) => result === winner), "every caller must learn the same winner");
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM player_class WHERE owner_key = $1",
        [ownerKey],
      );
      assert.equal(rows.rows[0]?.count, "1", "the PK must collapse concurrent upserts onto one row");
    });
  },
);
