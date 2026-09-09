import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type Pool as PgPool } from "pg";
import { BOSS_RESPAWN_MS } from "../rooms/monsterDefinitions";
import {
  InMemoryBossStateStore,
  PostgresBossStateStore,
  type BossStateStore,
} from "./bossStateStore";
import { runMigrations } from "./migrate";
import { getDatabaseStatus, resetDatabaseStatus } from "./status";

/**
 * Phase I Pass T1 (`docs/design-phase-i-boss-monster.md` §2.3, §8 T1): the two `BossStateStore`
 * implementations answer the same questions, for the reason `profileStore.test.ts` states about
 * its own pair — the in-memory one is not a test double but the path local development and this
 * whole suite actually run on, so a contract that drifts between them is only found in production.
 *
 * The spawn ids are the real ones (`monsterDefinitions.ts`), because this store is the first in
 * the directory keyed by a spawn row instead of an account (§2.1) and the ids are the whole of
 * that key.
 */
const HG_BOSS = "hg-boss-01";
const HD_BOSS = "hd-boss-01";

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

function assertBossStateStoreContract(label: string, create: () => BossStateStore): void {
  describe(`BossStateStore contract — ${label}`, () => {
    it("answers null for a spawn row it has never seen", async () => {
      assert.equal(await create().getLastDefeatedAt(HG_BOSS), null);
    });

    it("returns what was recorded", async () => {
      const store = create();
      const defeatedAt = Date.now() - 60_000;
      await store.recordDefeat(HG_BOSS, defeatedAt);
      assert.equal(await store.getLastDefeatedAt(HG_BOSS), defeatedAt);
    });

    it("keeps the two boss rows apart — one zone's timer is never the other's", async () => {
      // The whole reason this store is keyed by spawn id: hunting-ground and hunting-den run
      // independent 6-hour timers off one table (design §3).
      const store = create();
      const ground = Date.now() - 60_000;
      const den = Date.now() - 120_000;
      await store.recordDefeat(HG_BOSS, ground);
      await store.recordDefeat(HD_BOSS, den);
      assert.equal(await store.getLastDefeatedAt(HG_BOSS), ground);
      assert.equal(await store.getLastDefeatedAt(HD_BOSS), den);
    });

    it("overwrites rather than accumulating: a second defeat replaces the first", async () => {
      const store = create();
      const first = Date.now() - BOSS_RESPAWN_MS;
      const second = Date.now();
      await store.recordDefeat(HG_BOSS, first);
      await store.recordDefeat(HG_BOSS, second);
      assert.equal(await store.getLastDefeatedAt(HG_BOSS), second);
    });

    it("lets the later *call* win even when it carries the older timestamp", async () => {
      // "The later write wins" (design §2.3) is about call order, not about the larger number:
      // the two room instances of §1.1 converge on one deadline whichever of them wrote last.
      // Documented rather than merely observed, because it is also the one way a defeat deadline
      // can move backwards — bounded by the seconds between two instances' kills.
      const store = create();
      const newer = Date.now();
      const older = newer - 30_000;
      await store.recordDefeat(HG_BOSS, newer);
      await store.recordDefeat(HG_BOSS, older);
      assert.equal(await store.getLastDefeatedAt(HG_BOSS), older);
    });

    it("round-trips epoch 0, which must not read back as 'never defeated'", async () => {
      // `?? null` on a falsy 0 is the classic way to lose this, and `populateMonsters` reads null
      // as "start alive" — a 0 turning into null is a boss that is alive when it should not be.
      const store = create();
      await store.recordDefeat(HG_BOSS, 0);
      assert.equal(await store.getLastDefeatedAt(HG_BOSS), 0, "0 must survive as 0, not become null");
    });

    it("round-trips a timestamp exactly one respawn window old, to the millisecond", async () => {
      // The value `populateMonsters` compares against BOSS_RESPAWN_MS. A millisecond lost in the
      // round trip is a boss that starts alive one tick early or late.
      const store = create();
      const defeatedAt = Date.now() - BOSS_RESPAWN_MS;
      await store.recordDefeat(HG_BOSS, defeatedAt);
      assert.equal(await store.getLastDefeatedAt(HG_BOSS), defeatedAt);
    });

    it("round-trips a millisecond value that is not a whole second", async () => {
      const store = create();
      const defeatedAt = 1_757_000_000_123;
      await store.recordDefeat(HG_BOSS, defeatedAt);
      assert.equal(await store.getLastDefeatedAt(HG_BOSS), defeatedAt);
    });

    it("takes a spawn id containing SQL punctuation as data, not as SQL", async () => {
      const store = create();
      const hostile = "hg-boss-01'; DROP TABLE monster_defeat; --";
      const defeatedAt = Date.now();
      await store.recordDefeat(hostile, defeatedAt);
      assert.equal(await store.getLastDefeatedAt(hostile), defeatedAt);
      assert.equal(await store.getLastDefeatedAt(HG_BOSS), null, "and it is a different key");
    });

    it("settles every one of 25 concurrent records of one row on a value that was written", async () => {
      const store = create();
      const stamps = Array.from({ length: 25 }, (_, index) => 1_700_000_000_000 + index);
      await Promise.all(stamps.map((stamp) => store.recordDefeat(HG_BOSS, stamp)));
      const settled = await store.getLastDefeatedAt(HG_BOSS);
      assert.ok(
        settled !== null && stamps.includes(settled),
        `settled on ${settled}, which nobody wrote`,
      );
    });
  });
}

/** A stand-in Postgres: one row per spawn id, driven by the store's own SQL. */
function inMemoryBackedPostgresStore(): BossStateStore {
  const rows = new Map<string, Date>();
  const { pool } = stubPool((sql, values) => {
    const spawnId = String(values[0]);
    if (sql.includes("SELECT")) {
      const defeatedAt = rows.get(spawnId);
      return { rows: defeatedAt === undefined ? [] : [{ defeated_at: defeatedAt }] };
    }
    assert.ok(values[1] instanceof Date, "the store must hand pg a Date for a timestamptz column");
    rows.set(spawnId, values[1]);
    return { rows: [] };
  });
  return new PostgresBossStateStore(pool);
}

assertBossStateStoreContract("InMemoryBossStateStore", () => new InMemoryBossStateStore());
assertBossStateStoreContract("PostgresBossStateStore", inMemoryBackedPostgresStore);

describe("InMemoryBossStateStore", () => {
  it("keeps nothing across instances, so a restart looks like a boss that never died", async () => {
    const first = new InMemoryBossStateStore();
    await first.recordDefeat(HG_BOSS, Date.now());
    assert.equal(await new InMemoryBossStateStore().getLastDefeatedAt(HG_BOSS), null);
  });

  it("never touches the database status field", async () => {
    resetDatabaseStatus();
    const store = new InMemoryBossStateStore();
    await store.recordDefeat(HG_BOSS, Date.now());
    await store.getLastDefeatedAt(HG_BOSS);
    assert.equal(getDatabaseStatus(), "disabled", "the no-database mode must stay 'disabled'");
  });
});

describe("PostgresBossStateStore — the statements it sends", () => {
  beforeEach(resetDatabaseStatus);

  it("reads one row by spawn id and nothing else", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ defeated_at: new Date(1_700_000_000_000) }] }));
    assert.equal(await new PostgresBossStateStore(pool).getLastDefeatedAt(HG_BOSS), 1_700_000_000_000);
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? "", /SELECT defeated_at FROM monster_defeat WHERE spawn_id = \$1/);
    assert.deepEqual(queries[0]?.values, [HG_BOSS]);
  });

  it("writes with a single upsert, so two room instances cannot interleave a read and a write", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [] }));
    await new PostgresBossStateStore(pool).recordDefeat(HG_BOSS, 1_700_000_000_000);
    assert.equal(queries.length, 1, "read-modify-write would be two statements");
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /INSERT INTO monster_defeat/);
    assert.match(sql, /ON CONFLICT \(spawn_id\)/);
    assert.match(sql, /DO UPDATE SET defeated_at = EXCLUDED\.defeated_at/);
    assert.deepEqual(queries[0]?.values, [HG_BOSS, new Date(1_700_000_000_000)]);
  });

  it("answers null for an empty result set", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    assert.equal(await new PostgresBossStateStore(pool).getLastDefeatedAt(HG_BOSS), null);
  });

  it("does not turn a stored epoch 0 into null", async () => {
    const { pool } = stubPool(() => ({ rows: [{ defeated_at: new Date(0) }] }));
    assert.equal(await new PostgresBossStateStore(pool).getLastDefeatedAt(HG_BOSS), 0);
  });
});

describe("PostgresBossStateStore — health reporting", () => {
  beforeEach(resetDatabaseStatus);

  it("marks the database ok on a successful read and on a successful write", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    const store = new PostgresBossStateStore(pool);
    await store.getLastDefeatedAt(HG_BOSS);
    assert.equal(getDatabaseStatus(), "ok");
    resetDatabaseStatus();
    await store.recordDefeat(HG_BOSS, Date.now());
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database degraded and rethrows when a read fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(
      () => new PostgresBossStateStore(pool).getLastDefeatedAt(HG_BOSS),
      /connection terminated/,
      "the caller decides what a failed read means; the store must not swallow it",
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("marks the database degraded and rethrows when a write fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(
      () => new PostgresBossStateStore(pool).recordDefeat(HG_BOSS, Date.now()),
      /connection terminated/,
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("recovers to ok on the next query that succeeds", async () => {
    let fail = true;
    const { pool } = stubPool(() => {
      if (fail) {
        throw new Error("terminating connection due to administrator command");
      }
      return { rows: [{ defeated_at: new Date(1_700_000_000_000) }] };
    });
    const store = new PostgresBossStateStore(pool);
    await assert.rejects(() => store.getLastDefeatedAt(HG_BOSS));
    assert.equal(getDatabaseStatus(), "degraded");
    fail = false;
    assert.equal(await store.getLastDefeatedAt(HG_BOSS), 1_700_000_000_000);
    assert.equal(getDatabaseStatus(), "ok");
  });
});

/**
 * Opt-in against a real Postgres, the convention `inventoryStore.test.ts` and
 * `equipmentSlotsMigration.test.ts` already use — this is what proves `0005_monster_defeat.sql`
 * is valid DDL and that the UPSERT really is atomic under concurrent writers, neither of which a
 * synchronous stub can show:
 *
 *   docker run -d --rm --name zep-boss-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=zeptest \
 *     -p 55441:5432 postgres:17-alpine
 *   ZEP_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55441/zeptest npm test -w @zep-test/server
 *
 * Non-destructive by construction: every spawn id it writes is a fresh uuid, so pointing it at a
 * database that holds something else costs that database a handful of rows under keys nothing
 * else uses. It does run the migrations, which is deliberate — the DDL is part of what is tested.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

/** Maps the contract's fixed spawn ids onto fresh ones per `create()`, so cases cannot inherit rows. */
function spawnScopedStore(pool: PgPool): BossStateStore {
  const inner = new PostgresBossStateStore(pool);
  const ids = new Map<string, string>();
  const resolve = (spawnId: string): string => {
    let mapped = ids.get(spawnId);
    if (mapped === undefined) {
      mapped = `boss-${randomUUID()}`;
      ids.set(spawnId, mapped);
    }
    return mapped;
  };
  return {
    getLastDefeatedAt: (spawnId) => inner.getLastDefeatedAt(resolve(spawnId)),
    recordDefeat: (spawnId, defeatedAtMs) => inner.recordDefeat(resolve(spawnId), defeatedAtMs),
  };
}

describe(
  "PostgresBossStateStore — against a real server",
  { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false },
  () => {
    let pool: Pool;

    before(async () => {
      pool = new Pool({ connectionString: REAL_DATABASE_URL, max: 8 });
      // Applies 0001..0005; a broken `0005_monster_defeat.sql` fails the whole suite right here.
      await runMigrations(pool);
      resetDatabaseStatus();
    });

    after(async () => {
      await pool.end();
      resetDatabaseStatus();
    });

    assertBossStateStoreContract("PostgresBossStateStore on a real server", () =>
      spawnScopedStore(pool),
    );

    it("keeps one row per spawn id however many defeats it records", async () => {
      const store = new PostgresBossStateStore(pool);
      const spawnId = `boss-${randomUUID()}`;
      for (let index = 0; index < 5; index++) {
        await store.recordDefeat(spawnId, 1_700_000_000_000 + index);
      }
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM monster_defeat WHERE spawn_id = $1",
        [spawnId],
      );
      assert.equal(rows.rows[0]?.count, "1", "the PK must collapse repeat defeats onto one row");
      assert.equal(await store.getLastDefeatedAt(spawnId), 1_700_000_000_004);
    });

    it("loses nothing when two room instances record the same boss at once", async () => {
      // The §1.1 scenario for real: a pool of 8 connections and Postgres serialising the upserts
      // on the primary key. Either write may land last; what must not happen is a crash, a
      // duplicate row, or a value nobody wrote.
      const store = new PostgresBossStateStore(pool);
      const spawnId = `boss-${randomUUID()}`;
      const stamps = Array.from({ length: 16 }, (_, index) => 1_700_000_000_000 + index * 1000);
      await Promise.all(stamps.map((stamp) => store.recordDefeat(spawnId, stamp)));
      const settled = await store.getLastDefeatedAt(spawnId);
      assert.ok(settled !== null && stamps.includes(settled), `settled on ${settled}`);
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM monster_defeat WHERE spawn_id = $1",
        [spawnId],
      );
      assert.equal(rows.rows[0]?.count, "1");
    });

    it("stores the column as timestamptz, not as text or a bare integer", async () => {
      const store = new PostgresBossStateStore(pool);
      const spawnId = `boss-${randomUUID()}`;
      await store.recordDefeat(spawnId, 1_757_000_000_123);
      const typed = await pool.query<{ type: string }>(
        `SELECT pg_typeof(defeated_at)::text AS type FROM monster_defeat WHERE spawn_id = $1`,
        [spawnId],
      );
      assert.equal(typed.rows[0]?.type, "timestamp with time zone");
      assert.equal(
        await store.getLastDefeatedAt(spawnId),
        1_757_000_000_123,
        "sub-second precision has to survive the column, or the deadline drifts",
      );
    });

    it("rejects a null defeat time at the schema level", async () => {
      // NOT NULL is what stops a half-written row from reading as "defeated at an unknown time",
      // which `populateMonsters` has no branch for.
      await assert.rejects(
        () =>
          pool.query("INSERT INTO monster_defeat (spawn_id, defeated_at) VALUES ($1, NULL)", [
            `boss-${randomUUID()}`,
          ]),
        /null value in column "defeated_at"/,
      );
    });
  },
);
