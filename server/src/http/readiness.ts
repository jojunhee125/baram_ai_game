const NOT_STARTED_REASON = "startup checks have not completed";

/**
 * Boot-time readiness, written by the `beforeListen` map validation in `server.ts` and
 * read by `/api/health`. It starts *unhealthy* so a probe that somehow lands before
 * validation reports `ok:false` rather than claiming health nothing has established yet.
 */
let unhealthyReason: string | null = NOT_STARTED_REASON;

export function markReady(): void {
  unhealthyReason = null;
}

export function markUnhealthy(reason: string): void {
  unhealthyReason = reason;
}

/** `null` means healthy. */
export function getUnhealthyReason(): string | null {
  return unhealthyReason;
}

/** Test seam, mirroring the module's initial state. */
export function resetReadiness(): void {
  unhealthyReason = NOT_STARTED_REASON;
}
