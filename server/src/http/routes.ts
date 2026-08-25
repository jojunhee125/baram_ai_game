import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Application } from "express";
import { ROOM_DEFINITIONS } from "../rooms/definitions";
import { inspectForwardAuth } from "./forwardAuth";
import { getUnhealthyReason } from "./readiness";
import { getWsAuthProbeSnapshot, observeHttpRequest } from "./wsAuthProbe";

/**
 * `server/src/http` → `client/dist`. The container image keeps the same relative layout
 * (`/app/server`, `/app/client/dist`, `/app/assets`) so this resolves identically there.
 */
const CLIENT_DIST_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../../../client/dist");

const DIAGNOSTIC_PATH = "/api/diag/ws-auth";

/**
 * Routes for `new Server({ express })`. Colyseus registers its own matchmaking routes
 * (`/matchmake/*`) *after* this callback runs, so a catch-all here would swallow them —
 * there is deliberately no SPA fallback, only `express.static`, which calls `next()` for
 * paths it cannot resolve.
 */
export function configureHttpRoutes(app: Application): void {
  // Both diagnostics are registered ahead of the observer below on purpose: the container
  // health probe and the diagnostic call itself are not user traffic, and would otherwise
  // be the only thing `lastHttpRequest` ever reports.
  app.get("/api/health", (_request, response) => {
    const reason = getUnhealthyReason();
    // Always HTTP 200, even when unhealthy: oauth2-proxy behind the KAD gateway reads a
    // 401/403 as "not signed in" and sends the probe into an SSO redirect loop.
    response.status(200).json({
      status: reason === null ? "ok" : "degraded",
      ok: reason === null,
      uptimeSeconds: Math.round(process.uptime()),
      rooms: ROOM_DEFINITIONS.map((definition) => definition.name),
      ...(reason === null ? {} : { reason }),
    });
  });

  app.get(DIAGNOSTIC_PATH, (request, response) => {
    const snapshot = getWsAuthProbeSnapshot();
    // Header and cookie *names* only — see forwardAuth.ts. Also always 200, for the same
    // reason as above. This path stays behind SSO (never in `kad.public_paths`), because
    // an unauthenticated sample would tell us nothing about header propagation.
    response.status(200).json({
      observedAt: new Date().toISOString(),
      thisRequest: inspectForwardAuth(request.headers),
      lastHttpRequest: snapshot.lastHttpRequest,
      lastWebSocketUpgrade: snapshot.lastWebSocketUpgrade,
    });
  });

  app.use((request, _response, next) => {
    observeHttpRequest(request.headers);
    next();
  });

  if (!existsSync(CLIENT_DIST_DIRECTORY)) {
    console.warn(
      `[zep-test] client bundle missing at ${CLIENT_DIST_DIRECTORY}; serving the API only. Run "npm run build" to produce it.`,
    );
  }
  app.use(express.static(CLIENT_DIST_DIRECTORY));
}
