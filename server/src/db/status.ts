/**
 * What `/api/health` reports about persistence. `"disabled"` is a healthy state, not a
 * fault: a server booted without `DATABASE_URL` keeps profiles in process memory, which is
 * the normal local/test mode (design §2.4).
 */
export type DatabaseStatus = "disabled" | "ok" | "degraded";

let status: DatabaseStatus = "disabled";

export function markDatabaseOk(): void {
  status = "ok";
}

/**
 * A query or an idle connection failed *after* boot. This never makes `/api/health` report
 * `ok:false` — the compose probe greps that field and Coolify rolls the deployment back on
 * a miss, and a Postgres hiccup is not a reason to take movement and chat down with it.
 */
export function markDatabaseDegraded(reason: unknown): void {
  status = "degraded";
  console.error("[zep-test] database degraded:", reason);
}

export function getDatabaseStatus(): DatabaseStatus {
  return status;
}

/** Test seam, mirroring the module's initial state. */
export function resetDatabaseStatus(): void {
  status = "disabled";
}
