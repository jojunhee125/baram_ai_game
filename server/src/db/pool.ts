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
    // Profile/inventory/boss-state reads and writes are still roughly one per page load or
    // per action — but `ProgressStore` reads are not (design-phase-w2-level-client.md §1.3):
    // `CachedProgressStore` (`db/progressCache.ts`) makes every room's join path call
    // `getExp` once per account, and a cache hit answers in-process without touching this
    // pool at all — a room move, a rejoin, or a portal hop after the first join is free here,
    // ever, for the life of this process. The one load this pool actually has to absorb from
    // that path is a *cold-start burst*: a redeploy followed by up to CCU-many joins arriving
    // before any of them has warmed the cache, each firing one single-row primary-key read.
    //
    // `max: 4` still clears that burst comfortably rather than gaining nothing from a larger
    // pool: a single-row PK lookup is sub-millisecond to a few milliseconds, so even 500
    // concurrent cold misses queued four at a time (500 ÷ 4 × a few ms ≈ low hundreds of ms)
    // finishes well inside `connectionTimeoutMillis` (5_000, below) — nobody's join actually
    // waits long enough to time out acquiring a connection. `db/progressCache.test.ts`'s
    // "survives a cold-start burst" case models this queueing (not the real driver's pool,
    // which nothing in this process can safely fake) and confirms every join still resolves
    // to the right value with none lost or hung against a 4-wide bottleneck.
    //
    // Raise this only off a real measurement, not this arithmetic alone: a production redeploy
    // log showing pool-acquire wait times approaching (not just "elevated relative to normal",
    // but actually close to) `connectionTimeoutMillis` is the trigger design §1.6 already names
    // — until that is observed, a bigger pool only buys idle backends this load never needed.
    max: 4,
    idleTimeoutMillis: 30_000,
    // Never wait forever: an unresponsive database must not hold a request handler open.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 10_000,
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
