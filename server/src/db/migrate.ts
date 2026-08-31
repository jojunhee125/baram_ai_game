import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/**
 * `server/src/db` → `server/migrations`. The container image keeps the same relative layout
 * (`COPY server ./server`), so the SQL files resolve identically there.
 */
const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const SEQUENCE_LENGTH = 4;

/**
 * Coolify deploys by rolling restart, so the new container boots while the old one is still
 * running. Both would apply the same file and one would crash-loop on the primary-key
 * violation; the lock makes the loser wait and then find nothing pending.
 */
const ACQUIRE_LOCK = "SELECT pg_advisory_lock(hashtext('zep_test_schema_migration'))";
const RELEASE_LOCK = "SELECT pg_advisory_unlock(hashtext('zep_test_schema_migration'))";

export interface PendingMigration {
  /** The file name without `.sql`, which is what `schema_migration.version` stores. */
  version: string;
  fileName: string;
}

/**
 * Pure: directory listing and applied versions in, ordered work list out. Split from the
 * runner so the ordering rules are testable without a disk or a database.
 *
 * Non-`.sql` entries are ignored (a README in the directory is not a migration), but a
 * `.sql` file that breaks the `0001_snake_case.sql` convention throws rather than being
 * skipped — a migration silently left out is the failure mode this whole module exists to
 * prevent. Applied versions with no file are ignored, which is what an older container sees
 * after a rollback.
 */
export function planMigrations(
  fileNames: readonly string[],
  appliedVersions: readonly string[],
): readonly PendingMigration[] {
  const applied = new Set(appliedVersions);
  const seen = new Set<string>();
  const all: PendingMigration[] = [];

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".sql")) {
      continue;
    }
    if (!MIGRATION_FILE_PATTERN.test(fileName)) {
      throw new Error(
        `migration "${fileName}" does not follow the 0001_snake_case.sql naming convention`,
      );
    }
    const sequence = fileName.slice(0, SEQUENCE_LENGTH);
    if (seen.has(sequence)) {
      throw new Error(`two migrations share the sequence number ${sequence}`);
    }
    seen.add(sequence);
    all.push({ version: fileName.slice(0, -".sql".length), fileName });
  }

  all.sort((left, right) => (left.fileName < right.fileName ? -1 : 1));

  const pending = all.filter((migration) => !applied.has(migration.version));
  const lastApplied = all.filter((migration) => applied.has(migration.version)).at(-1);
  const first = pending[0];
  if (lastApplied !== undefined && first !== undefined && first.fileName < lastApplied.fileName) {
    // Forward-only means the file order *is* the applied order. A new file numbered below
    // something already in the database would run against a schema its author never saw.
    throw new Error(
      `migration "${first.fileName}" is pending but sorts before the applied "${lastApplied.fileName}"`,
    );
  }
  return pending;
}

/**
 * Applies every pending migration and returns the versions it applied. Forward-only: there
 * are no down migrations, and reverting means writing a new file.
 *
 * Everything runs on one checked-out client because advisory locks are session-scoped —
 * `pool.query` may hand each statement a different connection, which would take the lock on
 * one and release it on another.
 */
export async function runMigrations(
  pool: Pool,
  directory: string = MIGRATIONS_DIRECTORY,
): Promise<readonly string[]> {
  const fileNames = await readdir(directory);
  const client = await pool.connect();
  try {
    await client.query(ACQUIRE_LOCK);
    try {
      const pending = planMigrations(fileNames, await readAppliedVersions(client));
      for (const migration of pending) {
        const sql = await readFile(join(directory, migration.fileName), "utf8");
        await apply(client, migration, sql);
        console.log(`[zep-test] applied migration ${migration.version}`);
      }
      return pending.map((migration) => migration.version);
    } finally {
      await client.query(RELEASE_LOCK);
    }
  } finally {
    client.release();
  }
}

/**
 * The DDL and its bookkeeping row share one transaction, so a file that fails halfway leaves
 * neither the change nor a record claiming it was made.
 */
async function apply(client: PoolClient, migration: PendingMigration, sql: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migration (version) VALUES ($1)", [migration.version]);
    await client.query("COMMIT");
  } catch (cause) {
    await rollback(client);
    throw new Error(`migration "${migration.fileName}" failed: ${describe(cause)}`, { cause });
  }
}

/** The migration already failed; a failure to roll back must not hide which one it was. */
async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    console.error("[zep-test] rolling back a failed migration also failed:", error);
  }
}

/**
 * `schema_migration` is created by the first migration rather than by this runner, so before
 * that file has ever run there is no table to read — that absence is an empty applied set,
 * not an error.
 */
async function readAppliedVersions(client: PoolClient): Promise<readonly string[]> {
  const table = await client.query<{ name: string | null }>(
    "SELECT to_regclass('schema_migration')::text AS name",
  );
  if (table.rows[0]?.name == null) {
    return [];
  }
  const applied = await client.query<{ version: string }>("SELECT version FROM schema_migration");
  return applied.rows.map((row) => row.version);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
