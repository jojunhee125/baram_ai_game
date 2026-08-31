import { existsSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AVATAR_SKIN_COUNT } from "@zep-test/shared";
import express, {
  type Application,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  InMemoryInventoryStore,
  type InventoryRow,
  type InventoryStore,
} from "../db/inventoryStore";
import { InMemoryProfileStore, type ProfileStore } from "../db/profileStore";
import { getDatabaseStatus } from "../db/status";
import { ROOM_DEFINITIONS } from "../rooms/definitions";
import { ITEM_DEFINITIONS } from "../rooms/itemDefinitions";
import { deriveSsoUserId } from "../rooms/ssoIdentity";
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
 * Stays out of `kad.public_paths`: without the gateway's identity headers there is no
 * account to read or write, so an unauthenticated call here could only ever be a no-op.
 */
const PROFILE_PATH = "/api/profile";

/** Read-only and behind SSO for the same reason as {@link PROFILE_PATH}: no identity, no bag. */
const INVENTORY_PATH = "/api/inventory";

/** One integer field. Anything larger than this is not the body this route accepts. */
const PROFILE_BODY_LIMIT = "1kb";

/**
 * Routes for `new Server({ express })`. Colyseus registers its own matchmaking routes
 * (`/matchmake/*`) *after* this callback runs, so a catch-all here would swallow them —
 * there is deliberately no SPA fallback, only `express.static`, which calls `next()` for
 * paths it cannot resolve.
 *
 * Both stores default to their in-memory implementation, which is the mode a server booted
 * without `DATABASE_URL` runs in — `index.ts` always passes the stores it resolved at boot.
 */
export function configureHttpRoutes(
  app: Application,
  profileStore: ProfileStore = new InMemoryProfileStore(),
  inventoryStore: InventoryStore = new InMemoryInventoryStore(),
): void {
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
      // Reported separately from `ok` on purpose: a database that stops answering must not
      // flip `ok` to false, because the compose healthcheck greps that field and Coolify
      // rolls the deployment back on a miss.
      db: getDatabaseStatus(),
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

  // Registered after the observer, unlike the two diagnostics above: these are real user
  // traffic carrying real gateway headers, which is exactly what PoC #1 wants sampled.
  app.get(PROFILE_PATH, (request, response) => {
    void handleReadProfile(profileStore, request, response);
  });
  app.post(PROFILE_PATH, parseJsonBody, (request, response) => {
    void handleWriteProfile(profileStore, request, response);
  });
  app.get(INVENTORY_PATH, (request, response) => {
    void handleReadInventory(inventoryStore, request, response);
  });

  if (!existsSync(CLIENT_DIST_DIRECTORY)) {
    console.warn(
      `[zep-test] client bundle missing at ${CLIENT_DIST_DIRECTORY}; serving the API only. Run "npm run build" to produce it.`,
    );
  }
  app.use(express.static(CLIENT_DIST_DIRECTORY));
}

/**
 * Express' default error handler answers a parse failure with an HTML page carrying the
 * stack trace — absolute paths and all — where this route promises JSON. Anything the parser
 * rejects, oversized or unparseable, is the same thing from the caller's side: not a body
 * this route can read.
 */
const parseJsonBody: RequestHandler = (request, response, next) => {
  express.json({ limit: PROFILE_BODY_LIMIT })(request, response, (error: unknown) => {
    if (error === undefined || error === null) {
      next();
      return;
    }
    response.status(400).json({ error: "body must be a JSON object" });
  });
};

/**
 * Read before the avatar picker opens, which happens before any room connection exists —
 * that ordering is why the profile lives on HTTP rather than on a join response.
 *
 * No identity (local dev, or a request that skipped the gateway) answers `{ avatarSkin: null }`
 * rather than 401: this service never says "not signed in" with a 4xx, because oauth2-proxy
 * turns one into an SSO redirect loop.
 */
async function handleReadProfile(
  store: ProfileStore,
  request: Request,
  response: Response,
): Promise<void> {
  const ownerKey = deriveSsoUserId(readAccessToken(request.headers));
  if (ownerKey === null) {
    response.status(200).json({ avatarSkin: null });
    return;
  }
  try {
    response.status(200).json({ avatarSkin: await store.getAvatarSkin(ownerKey) });
  } catch {
    // The store logged the cause and flagged the health field. A picker that cannot read a
    // stored choice offers its default, which is what null already means here.
    console.warn(`[zep-test] GET ${PROFILE_PATH} could not read a stored skin; answering null`);
    response.status(200).json({ avatarSkin: null });
  }
}

/**
 * Written once per session, when the picker is confirmed. Deliberately not written from
 * `onJoin`: that is the 500-CCU connection path, and keeping the database off it is the
 * whole reason skin persistence is the first feature to use one.
 */
async function handleWriteProfile(
  store: ProfileStore,
  request: Request,
  response: Response,
): Promise<void> {
  const avatarSkin = parseAvatarSkin(request.body);
  if (avatarSkin === null) {
    response
      .status(400)
      .json({ error: `avatarSkin must be an integer in [0, ${AVATAR_SKIN_COUNT})` });
    return;
  }
  const ownerKey = deriveSsoUserId(readAccessToken(request.headers));
  if (ownerKey === null) {
    // Nothing to file it under, so nothing is stored — but the choice itself was valid and
    // the session keeps using it, so this is a 200 and not an error.
    response.status(200).json({ avatarSkin });
    return;
  }
  try {
    await store.setAvatarSkin(ownerKey, avatarSkin);
    response.status(200).json({ avatarSkin });
  } catch {
    // Answered honestly rather than echoing a 200 the storage never earned. 503 and not
    // 401/403 — see handleReadProfile for what a 4xx does behind oauth2-proxy.
    console.warn(`[zep-test] POST ${PROFILE_PATH} could not persist the skin`);
    response.status(503).json({ error: "profile store unavailable" });
  }
}

/**
 * Read when the bag window opens, and only then: the inventory belongs to the account rather
 * than to a room, so putting it on HTTP keeps every database query off the room message path
 * (design §3.4) — the same argument that put the profile here.
 *
 * No identity answers `{ items: [] }` rather than 401, for the reason `handleReadProfile`
 * explains. A failing store does *not* take that path: an empty bag would tell the player their
 * loot is gone, so this answers 503 the way the profile *write* does. The asymmetry with the
 * profile read is deliberate — there, null means "the picker shows its default", which is true
 * whether or not the read worked.
 */
async function handleReadInventory(
  store: InventoryStore,
  request: Request,
  response: Response,
): Promise<void> {
  const ownerKey = deriveSsoUserId(readAccessToken(request.headers));
  if (ownerKey === null) {
    response.status(200).json({ items: [] });
    return;
  }
  try {
    response.status(200).json({ items: presentInventory(await store.list(ownerKey)) });
  } catch {
    // The store logged the cause and flagged the health field; `db: "degraded"` never flips
    // `ok`, so this failure does not put the deployment at risk of a rollback.
    console.warn(`[zep-test] GET ${INVENTORY_PATH} could not read the bag`);
    response.status(503).json({ error: "inventory store unavailable" });
  }
}

/**
 * Joins the stored amounts to their display strings, which the client never looks up itself: a
 * bundle older than the server then still draws what it was handed (design §3.4), the discipline
 * the fixed objects already follow by sending their content with the panel.
 *
 * Driven by `ITEM_DEFINITIONS` rather than by the rows, which does two things at once: the result
 * comes out in the table's order — the bag's display order — and a row whose key has left the
 * table is dropped instead of rendering as a nameless entry. That is the right way round, because
 * the code table is the definition of what an item is and the database only stores amounts.
 */
function presentInventory(rows: readonly InventoryRow[]): readonly {
  itemKey: string;
  name: string;
  icon: string;
  quantity: number;
}[] {
  const quantities = new Map(rows.map((row) => [row.itemKey, row.quantity]));
  const items = [];
  for (const definition of ITEM_DEFINITIONS) {
    const quantity = quantities.get(definition.key);
    if (quantity === undefined) {
      continue;
    }
    items.push({
      itemKey: definition.key,
      name: definition.name,
      icon: definition.icon,
      quantity,
    });
  }
  return items;
}

/**
 * Out-of-range values are refused rather than clamped: the room clamps an unknown skin to 0
 * to keep a join alive, but persisting a 0 nobody picked would make that clamp permanent.
 */
function parseAvatarSkin(body: unknown): number | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const value = (body as Record<string, unknown>)["avatarSkin"];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value >= 0 && value < AVATAR_SKIN_COUNT ? value : null;
}

/** node lower-cases incoming header names, and repeats one as an array. */
function readAccessToken(headers: IncomingHttpHeaders): string | null {
  const header = headers["x-auth-request-access-token"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
