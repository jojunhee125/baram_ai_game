import { Pool } from "pg";
import { markDatabaseDegraded } from "./status";

/**
 * `null` means "no database configured", which is a mode rather than a failure (design
 * §2.4): the server test suite, `tools/loadtest-poc2.mjs` and `npm run dev` all run without
 * Postgres, and KAD always injects the URL in production. An all-whitespace value is read as
 * absent — an env var set to "" by a deployment template is not a connection string.
 */
export function resolveDatabaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Connects and proves it with `SELECT 1`, because a pool that has never been used holds no
 * evidence that the URL points at anything. The caller boots on the result: a configured
 * database that does not answer is a deployment error, and coming up anyway would silently
 * discard everything anyone saved that day.
 */
export async function createPool(databaseUrl: string): Promise<Pool> {
  const pool = new Pool({
    connectionString: databaseUrl,
    // Writes are one per profile change and reads one per page load, so a single Node
    // process gains nothing from a larger pool but pinned idle backends.
    max: 4,
    idleTimeoutMillis: 30_000,
    // Never wait forever: an unresponsive database must not hold a request handler open.
    connectionTimeoutMillis: 5_000,
    // No `ssl` option on purpose — KAD's internal Postgres does not speak TLS, and `pg`
    // connects in plaintext when the option is absent. Nothing to do is the correct action.
  });

  // node-postgres crashes the process on an idle client's `error` event when nothing is
  // listening. A database that drops a connection has to degrade the health field, not take
  // the room server with it.
  pool.on("error", (error) => {
    markDatabaseDegraded(error);
  });

  try {
    await pool.query("SELECT 1");
  } catch (cause) {
    await closeQuietly(pool);
    throw new Error(`database connection check failed: ${describe(cause)}`, { cause });
  }
  return pool;
}

/** The connection check already failed; a failure to clean up after it must not mask it. */
async function closeQuietly(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch (error) {
    console.warn("[zep-test] closing the failed connection pool also failed:", error);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
