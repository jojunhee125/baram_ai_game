import type { Pool, PoolClient } from "pg";

/**
 * Runs `fn` on one checked-out client inside `BEGIN`/`COMMIT`, rolling back and re-throwing
 * unchanged on any failure — `migrate.ts`'s own `apply`, this project's only prior multi-statement
 * transaction, and for the same reason: `pool.query` may hand each statement a different
 * connection, which would let a `BEGIN` and its matching `COMMIT` land on two different sessions
 * and transaction nothing together at all.
 *
 * The caller decides what a failed `fn` means — this never swallows an error to turn it into a
 * result, `PostgresQuestStore.query`'s own convention. `SettlementStore.settle`
 * (`settlementStore.ts`) is what turns an *expected* decline (insufficient balance, a full bag)
 * into a normal return value, and it does that above this function, not by changing this one.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (cause) {
      await rollback(client);
      throw cause;
    }
  } finally {
    client.release();
  }
}

/** The transaction already failed; a failure to roll back must not hide which one it was. */
async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    console.error("[zep-test] rolling back a failed transaction also failed:", error);
  }
}
