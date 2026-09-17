import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "./migrate";
import { resetDatabaseStatus } from "./status";
import { PostgresQuestStore } from "./questStore";

/**
 * The half of `PostgresQuestStore` no stub can reach: whether two connections racing the same
 * `UPDATE` really do serialize on Postgres's own row lock the way
 * `docs/implementation-2026-09-16-quest-state.md` §동시성 claims, rather than on the stub's
 * single-threaded JS event loop, which cannot fake a genuine interleave. That doc marked this
 * `[needs verification]` — this file is what closes it.
 *
 * Opt-in, same convention as `inventoryStore.test.ts`'s own real-server block:
 *
 *   wsl -d Ubuntu -- docker run -d --name zep-pg -e POSTGRES_PASSWORD=zep -p 55432:5432 postgres:16
 *   ZEP_TEST_DATABASE_URL=postgres://postgres:zep@127.0.0.1:55432/postgres npm test -w @zep-test/server
 *
 * Runs the real migration set via `runMigrations` (the DDL is part of what is under test) and
 * scopes every row to a fresh `randomUUID()` owner per test, so it is non-destructive to whatever
 * else the target database holds.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

describe(
  "PostgresQuestStore — concurrency against a real server",
  { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false },
  () => {
    let pool: Pool;
    let store: PostgresQuestStore;

    before(async () => {
      pool = new Pool({ connectionString: REAL_DATABASE_URL, max: 8 });
      await runMigrations(pool);
      resetDatabaseStatus();
    });

    after(async () => {
      await pool.end();
      resetDatabaseStatus();
    });

    /** Raw read past the store's own interface, for the columns `QuestRow` deliberately omits. */
    async function readRow(
      ownerKey: string,
      questId: string,
    ): Promise<{ killCount: number; completedAt: Date | null; updatedAt: Date } | undefined> {
      const result = await pool.query<{
        kill_count: number;
        completed_at: Date | null;
        updated_at: Date;
      }>(
        "SELECT kill_count, completed_at, updated_at FROM quest_progress WHERE owner_key = $1 AND quest_id = $2",
        [ownerKey, questId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : { killCount: row.kill_count, completedAt: row.completed_at, updatedAt: row.updated_at };
    }

    it("two concurrent kills increase the counter exactly twice and only one observes completion", async () => {
      store = new PostgresQuestStore(pool);
      const owner = randomUUID();
      const quest = "first-hunt";
      await store.accept(owner, quest);

      const [a, b] = await Promise.all([
        store.recordKill(owner, quest, 2),
        store.recordKill(owner, quest, 2),
      ]);
      assert.ok(a && b, "neither concurrent call should be dropped as a no-op");

      const killCounts = [a!.killCount, b!.killCount].sort();
      assert.deepEqual(killCounts, [1, 2], "the counter advanced by exactly one per call, not lost or doubled");

      const completions = [a!.completed, b!.completed].filter(Boolean);
      assert.equal(completions.length, 1, "exactly one of the two return values observed the completion transition");

      const row = await readRow(owner, quest);
      assert.equal(row?.killCount, 2);
      assert.ok(row?.completedAt, "the requirement was met, so the row itself is completed");
    });

    it("completed_at IS NULL guard: a kill after completion changes nothing", async () => {
      store = new PostgresQuestStore(pool);
      const owner = randomUUID();
      const quest = "first-hunt";
      await store.accept(owner, quest);
      const completing = await store.recordKill(owner, quest, 1);
      assert.deepEqual(completing, { questId: quest, killCount: 1, completed: true });

      const before1 = await readRow(owner, quest);
      const again = await store.recordKill(owner, quest, 1);
      assert.equal(again, null, "a kill against a completed quest must not report progress");
      const after1 = await readRow(owner, quest);
      assert.equal(after1?.killCount, before1?.killCount, "kill_count is untouched");
      assert.deepEqual(after1?.completedAt, before1?.completedAt, "completed_at is untouched, not refreshed");
    });

    it("LEAST clamp: the counter never exceeds the requirement under concurrency", async () => {
      store = new PostgresQuestStore(pool);
      const owner = randomUUID();
      const quest = "first-hunt";
      const required = 3;
      await store.accept(owner, quest);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.recordKill(owner, quest, required)),
      );
      const nonNull = results.filter((result): result is NonNullable<typeof result> => result !== null);
      assert.equal(nonNull.length, required, "only as many calls as the requirement may credit progress");
      assert.equal(results.length - nonNull.length, 2, "the rest must see the completed_at guard and no-op");
      for (const result of nonNull) {
        assert.ok(result.killCount <= required, `kill_count ${result.killCount} exceeded the requirement`);
      }

      const row = await readRow(owner, quest);
      assert.equal(row?.killCount, required, "the stored counter never overshoots even with 5 racing writers");
      assert.ok(row?.completedAt);
    });

    it("accept is idempotent and does not touch updated_at, including concurrent accepts", async () => {
      store = new PostgresQuestStore(pool);
      const owner = randomUUID();
      const quest = "first-hunt";
      await store.accept(owner, quest);
      await store.recordKill(owner, quest, 5);
      const beforeRow = await readRow(owner, quest);
      assert.ok(beforeRow);

      // A single re-accept after progress: must not look like a fresh accept.
      const reaccepted = await store.accept(owner, quest);
      assert.deepEqual(reaccepted, { questId: quest, killCount: 1, completed: false }, "progress survives re-accept");
      const afterSingle = await readRow(owner, quest);
      assert.deepEqual(afterSingle?.updatedAt, beforeRow.updatedAt, "a re-accept must not touch updated_at");

      // Two concurrent accepts on a brand new row: only one can be the real "first" acceptance,
      // but both must answer the same settled state and neither may disturb the other's write.
      const otherOwner = randomUUID();
      const [x, y] = await Promise.all([
        store.accept(otherOwner, quest),
        store.accept(otherOwner, quest),
      ]);
      assert.deepEqual(x, { questId: quest, killCount: 0, completed: false });
      assert.deepEqual(y, { questId: quest, killCount: 0, completed: false });
      const rows = await pool.query("SELECT count(*)::int AS n FROM quest_progress WHERE owner_key = $1", [
        otherOwner,
      ]);
      assert.equal(rows.rows[0].n, 1, "concurrent accepts must not create two rows for one owner+quest");
    });

    it("a kill for an account that never accepted creates no row", async () => {
      store = new PostgresQuestStore(pool);
      const owner = randomUUID();
      const quest = "first-hunt";
      const result = await store.recordKill(owner, quest, 3);
      assert.equal(result, null);
      const row = await readRow(owner, quest);
      assert.equal(row, undefined, "no row must exist for a quest that was never accepted");
    });
  },
);
