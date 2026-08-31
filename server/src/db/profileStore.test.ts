import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Pool } from "pg";
import { InMemoryProfileStore, PostgresProfileStore, type ProfileStore } from "./profileStore";
import { getDatabaseStatus, resetDatabaseStatus } from "./status";

const OWNER = "1f0d1a9c-6b7e-4f2a-9c31-0c4c2a5b8e10";
const OTHER_OWNER = "7c2b4d55-1e3f-4a88-b0d2-9f6e5c4a3b21";

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
}

/**
 * The narrow slice of `pg.Pool` the store touches. Casting a stub rather than reaching for a
 * real Postgres keeps these in the suite that runs without one — the end-to-end proof that the
 * SQL is valid is a separate container run, not this file.
 */
function stubPool(
  respond: (sql: string, values: readonly unknown[]) => { rows: Record<string, unknown>[] },
): { pool: Pool; queries: RecordedQuery[] } {
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
  } as unknown as Pool;
  return { pool, queries };
}

/**
 * Both implementations answer the same questions, because one of them is what local
 * development and the whole server suite actually run on (design §2.4) — a contract that
 * drifts between them would only be found in production.
 */
function assertProfileStoreContract(label: string, create: () => ProfileStore): void {
  describe(`ProfileStore contract — ${label}`, () => {
    it("answers null for an owner it has never seen", async () => {
      assert.equal(await create().getAvatarSkin(OWNER), null);
    });

    it("returns what was written", async () => {
      const store = create();
      await store.setAvatarSkin(OWNER, 7);
      assert.equal(await store.getAvatarSkin(OWNER), 7);
    });

    it("overwrites rather than accumulating on a second write", async () => {
      const store = create();
      await store.setAvatarSkin(OWNER, 7);
      await store.setAvatarSkin(OWNER, 23);
      assert.equal(await store.getAvatarSkin(OWNER), 23);
    });

    it("keeps two owners apart", async () => {
      const store = create();
      await store.setAvatarSkin(OWNER, 3);
      await store.setAvatarSkin(OTHER_OWNER, 11);
      assert.equal(await store.getAvatarSkin(OWNER), 3);
      assert.equal(await store.getAvatarSkin(OTHER_OWNER), 11);
    });

    it("round-trips skin 0, which must not read back as 'never chose'", async () => {
      // The first sheet cell is a legitimate choice and `?? null` on a falsy 0 is the classic
      // way to lose it — the picker would reopen on 0 either way, so nothing else would notice.
      const store = create();
      await store.setAvatarSkin(OWNER, 0);
      assert.equal(await store.getAvatarSkin(OWNER), 0, "0 must survive as 0, not become null");
    });

    it("round-trips the last skin of the sheet", async () => {
      const store = create();
      await store.setAvatarSkin(OWNER, 23);
      assert.equal(await store.getAvatarSkin(OWNER), 23);
    });
  });
}

/** A stand-in Postgres: one row per owner, with the store's own SQL driving it. */
function inMemoryBackedPostgresStore(): ProfileStore {
  const rows = new Map<string, number>();
  const { pool } = stubPool((sql, values) => {
    const ownerKey = String(values[0]);
    if (sql.includes("SELECT")) {
      const skin = rows.get(ownerKey);
      return { rows: skin === undefined ? [] : [{ avatar_skin: skin }] };
    }
    rows.set(ownerKey, Number(values[1]));
    return { rows: [] };
  });
  return new PostgresProfileStore(pool);
}

assertProfileStoreContract("InMemoryProfileStore", () => new InMemoryProfileStore());
assertProfileStoreContract("PostgresProfileStore", inMemoryBackedPostgresStore);

describe("InMemoryProfileStore", () => {
  it("keeps nothing across instances, which is what makes a restart look like a first visit", async () => {
    const first = new InMemoryProfileStore();
    await first.setAvatarSkin(OWNER, 9);
    assert.equal(await new InMemoryProfileStore().getAvatarSkin(OWNER), null);
  });

  it("never touches the database status field", async () => {
    resetDatabaseStatus();
    const store = new InMemoryProfileStore();
    await store.setAvatarSkin(OWNER, 4);
    await store.getAvatarSkin(OWNER);
    assert.equal(getDatabaseStatus(), "disabled", "the no-database mode must stay 'disabled'");
  });
});

describe("PostgresProfileStore — the statements it sends", () => {
  beforeEach(resetDatabaseStatus);

  it("reads one row by owner key and nothing else", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ avatar_skin: 5 }] }));
    assert.equal(await new PostgresProfileStore(pool).getAvatarSkin(OWNER), 5);
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? "", /SELECT avatar_skin FROM player_profile WHERE owner_key = \$1/);
    assert.deepEqual(queries[0]?.values, [OWNER]);
  });

  it("writes with a single upsert, so two tabs cannot interleave a read and a write", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [] }));
    await new PostgresProfileStore(pool).setAvatarSkin(OWNER, 12);
    assert.equal(queries.length, 1, "read-modify-write would be two statements");
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /INSERT INTO player_profile/);
    assert.match(sql, /ON CONFLICT \(owner_key\)/);
    assert.match(sql, /DO UPDATE SET avatar_skin = EXCLUDED\.avatar_skin/);
    assert.match(sql, /updated_at = now\(\)/, "a stale updated_at makes the row's history a lie");
    assert.deepEqual(queries[0]?.values, [OWNER, 12]);
  });

  it("answers null for an empty result set", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    assert.equal(await new PostgresProfileStore(pool).getAvatarSkin(OWNER), null);
  });

  it("does not turn a stored 0 into null", async () => {
    const { pool } = stubPool(() => ({ rows: [{ avatar_skin: 0 }] }));
    assert.equal(await new PostgresProfileStore(pool).getAvatarSkin(OWNER), 0);
  });
});

describe("PostgresProfileStore — health reporting", () => {
  beforeEach(resetDatabaseStatus);

  it("marks the database ok on a successful read", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    await new PostgresProfileStore(pool).getAvatarSkin(OWNER);
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database ok on a successful write", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    await new PostgresProfileStore(pool).setAvatarSkin(OWNER, 1);
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database degraded and rethrows when a read fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(
      () => new PostgresProfileStore(pool).getAvatarSkin(OWNER),
      /connection terminated/,
      "the route decides what a failed read means; the store must not swallow it",
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("marks the database degraded and rethrows when a write fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(() => new PostgresProfileStore(pool).setAvatarSkin(OWNER, 2), /connection terminated/);
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("recovers to ok on the next query that succeeds", async () => {
    let fail = true;
    const { pool } = stubPool(() => {
      if (fail) {
        throw new Error("terminating connection due to administrator command");
      }
      return { rows: [{ avatar_skin: 6 }] };
    });
    const store = new PostgresProfileStore(pool);
    await assert.rejects(() => store.getAvatarSkin(OWNER));
    assert.equal(getDatabaseStatus(), "degraded");
    fail = false;
    assert.equal(await store.getAvatarSkin(OWNER), 6);
    assert.equal(getDatabaseStatus(), "ok", "a database that answers again must stop reading as degraded");
  });

  it("reports a rejected value the pg driver never wrapped in an Error", async () => {
    const { pool } = stubPool(() => {
      throw "socket hang up";
    });
    await assert.rejects(() => new PostgresProfileStore(pool).getAvatarSkin(OWNER));
    assert.equal(getDatabaseStatus(), "degraded");
  });
});
