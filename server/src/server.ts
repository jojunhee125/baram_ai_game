import { createServer } from "node:http";
import { Encoder } from "@colyseus/schema";
import { Server, WebSocketTransport } from "colyseus";
import type { BossStateStore } from "./db/bossStateStore";
import type { InventoryStore } from "./db/inventoryStore";
import type { ProfileStore } from "./db/profileStore";
import type { ProgressStore } from "./db/progressStore";
import { validateInteractableDefinitions } from "./game/interactables";
import { validateItemDefinitions } from "./game/items";
import { validateLandmarkDefinitions } from "./game/landmarks";
import { validatePortalDefinitions } from "./game/portals";
import { TiledMapLoader } from "./game/tiledMap";
import { markReady, markUnhealthy } from "./http/readiness";
import { configureHttpRoutes } from "./http/routes";
import { observeWebSocketUpgrade } from "./http/wsAuthProbe";
import type { CollisionMap } from "./rooms/contracts";
import { ROOM_DEFINITIONS } from "./rooms/definitions";
import { INTERACTABLE_DEFINITIONS } from "./rooms/interactableDefinitions";
import { ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS } from "./rooms/itemDefinitions";
import { LANDMARK_DEFINITIONS, LANDMARK_DESCRIPTORS } from "./rooms/landmarkDefinitions";
import { MetaverseRoom } from "./rooms/metaverseRoom";
import {
  MONSTER_SPAWN_DEFINITIONS,
  MONSTER_TYPES,
  validateMonsterSpawnDefinitions,
} from "./rooms/monsterDefinitions";
import { PORTAL_DEFINITIONS } from "./rooms/portalDefinitions";

export const DEFAULT_PORT = 2567;

/**
 * All four stores are resolved at boot by `index.ts` — Postgres when `DATABASE_URL` is set and
 * process memory when it is not. Omitting them takes the same in-memory path, which is what a
 * test or a local `npm run dev` runs on. `adminOwnerKeys` defaults to nobody exempt, the same
 * "opt in, never a hardcoded key" default `ADMIN_OWNER_KEYS` is meant to have
 * (design-phase-w-level-system.md §11.0).
 */
export function createGameServer(
  profileStore?: ProfileStore,
  inventoryStore?: InventoryStore,
  bossStateStore?: BossStateStore,
  progressStore?: ProgressStore,
  adminOwnerKeys: ReadonlySet<string> = new Set(),
): Server {
  // Has to be set explicitly: the 8 KB default is nowhere near one patch of a 500-view room.
  // Every client's view is appended to one shared buffer, so a patch needs the sum of all 500
  // views at once — PoC #2 measured ~6.5 MB, and the 2026-08-27 viewport widening
  // (VIEW_RADIUS_TILES 13 -> 19) took that peak to ~10.9 MB.
  //
  // Still 1 MB, because this is the growth step and not a target. The encoder warns and
  // re-encodes only when one view's chunk overruns the free space, and a chunk is ~20 KB
  // (10.9 MB spread over 500 views): `tools/loadtest-poc2.mjs` counts 380-500 warnings per
  // 25 patches at the 8 KB default and 0 at 1 MB, in every scenario it runs. Raising it only
  // buys memory — `ensureCapacity` rounds up to a multiple of this, so the 10.9 MB peak settles
  // at 12 MB here and at 24 MB with an 8 MB step, and every room allocates two of these buffers
  // (the encoder's and the serializer's full-state one) before its first client arrives.
  Encoder.BUFFER_SIZE = 1024 * 1024;

  // One HTTP server carries the client bundle, the matchmaking API and the websocket
  // upgrade: the KAD gateway authenticates and forwards exactly one origin, so a second
  // port would sit outside SSO entirely.
  const httpServer = createServer();

  // Colyseus `Server.listen()` neither rejects nor settles when the bind fails, and an
  // http server with no `error` listener just sits there — so a taken port produces a
  // process that hangs forever with no output. That has cost this project twice: the
  // 2573 port collision between two test files, and a 290s silent stall measured on
  // 2026-08-31 when a crashed run still held the port. Throwing here turns the hang into
  // an uncaught exception that names the port, which is the whole point: a loud failure
  // is cheap to diagnose and a silent one is not.
  httpServer.on("error", (cause: NodeJS.ErrnoException & { port?: number }) => {
    const where = cause.code === "EADDRINUSE" ? ` — port ${cause.port} is already in use` : "";
    throw new Error(`HTTP server failed to bind${where}`, { cause });
  });

  // Read-only. `ws` owns this event too and completes the handshake from its own
  // listener; touching the socket here would break it.
  httpServer.on("upgrade", (request) => {
    observeWebSocketUpgrade(request.headers);
  });

  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    express: (app) => configureHttpRoutes(app, profileStore, inventoryStore),
    beforeListen: validateRoomMaps,
  });

  for (const definition of ROOM_DEFINITIONS) {
    // The stores are injected here rather than authored into `ROOM_DEFINITIONS`, which stays a
    // data table: these are the live objects a room needs. Rooms and `GET /api/inventory` share
    // one `inventoryStore` instance, so a drop is visible in the bag the moment it is credited.
    //
    // `realCapacity` is resolved to a value here rather than left to `onCreate`'s own `??`
    // fallback, and that is a security boundary, not a style choice: `onCreate` is handed
    // `merge({}, clientOptions, handler.options)` (Colyseus `MatchMaker.createRoom`), and that
    // merge copies only the keys this object actually *has*. A row that omits `realCapacity`
    // would therefore leave the join cap standing at whatever the client that happened to create
    // the instance asked for — `realCapacity: 1` in the join options of the first client into
    // grand-plaza refuses every later join of a room `maxClients` says is nearly empty, so the
    // matchmaker opens no second instance and nobody else gets in until that client disconnects.
    // Present-and-undefined is enough to close it (the stores rely on the same thing), but a
    // number is what the field means.
    gameServer.define(definition.name, MetaverseRoom, {
      ...definition,
      realCapacity: definition.realCapacity ?? definition.maxClients,
      inventoryStore,
      bossStateStore,
      progressStore,
      adminOwnerKeys,
    });
  }
  return gameServer;
}

export function resolvePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/**
 * `ADMIN_OWNER_KEYS` is a comma-separated allowlist of `sub` UUIDs exempt from the death EXP
 * penalty (design-phase-w-level-system.md §11.0) — an env value, never a literal in this file, so
 * who is exempt is a deploy-time decision rather than a code change. Blank segments (a trailing
 * comma, doubled separators, surrounding whitespace) are dropped rather than becoming an
 * empty-string "admin".
 */
export function resolveAdminOwnerKeys(value: string | undefined): ReadonlySet<string> {
  const keys = (value ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  return new Set(keys);
}

/**
 * A map that fails to load is a packaging error — the asset directory did not make it
 * into the image — and it would otherwise surface as a 500 on the first join of a server
 * that had been reporting itself healthy for hours. Refuse to boot instead.
 *
 * The spawn checks are here for the same reason: a spawn centre inside a wall strands every
 * client that joins that room, and nothing would reveal it until the first join. Portal
 * triggers and arrivals are checked on the same grounds — a portal is only ever exercised by
 * someone walking into that one door.
 */
async function validateRoomMaps(): Promise<void> {
  const loader = new TiledMapLoader();
  const maps = new Map<string, CollisionMap>();
  /** Keyed by room name, not mapKey: the portal table names rooms, and rooms may share a map. */
  const mapsByRoom = new Map<string, CollisionMap>();

  for (const definition of ROOM_DEFINITIONS) {
    let map = maps.get(definition.mapKey);
    if (map === undefined) {
      try {
        map = await loader.load(definition.mapKey);
      } catch (cause) {
        refuseBoot(`map "${definition.mapKey}" failed to load`, cause);
      }
      maps.set(definition.mapKey, map);
    }
    mapsByRoom.set(definition.name, map);

    const { spawn } = definition;
    if (spawn.spreadRadiusInTiles < 0) {
      refuseBoot(
        `room "${definition.name}" has a negative spawn spreadRadiusInTiles (${spawn.spreadRadiusInTiles})`,
      );
    }
    // isWalkable() reports out-of-bounds tiles as blocked, so this covers both checks.
    if (!map.isWalkable(spawn.tileX, spawn.tileY)) {
      refuseBoot(
        `room "${definition.name}" spawns at (${spawn.tileX},${spawn.tileY}), which is not a walkable tile of map "${definition.mapKey}"`,
      );
    }
  }

  const { errors, warnings } = validatePortalDefinitions(PORTAL_DEFINITIONS, mapsByRoom, ITEM_DEFINITIONS);
  for (const warning of warnings) {
    console.warn(`[zep-test] ${warning}`);
  }
  if (errors.length > 0) {
    refuseBoot(`invalid portal definitions: ${errors.join("; ")}`);
  }

  // Takes the portal table too: two of its checks are about the two tables together, and a tile
  // that fires both would open a panel into a room the player is already leaving.
  const objects = validateInteractableDefinitions(
    INTERACTABLE_DEFINITIONS,
    PORTAL_DEFINITIONS,
    mapsByRoom,
    ROOM_DEFINITIONS,
  );
  for (const warning of objects.warnings) {
    console.warn(`[zep-test] ${warning}`);
  }
  if (objects.errors.length > 0) {
    refuseBoot(`invalid interactable definitions: ${objects.errors.join("; ")}`);
  }

  // No map argument: an item is not placed anywhere. It is checked here anyway because this is
  // where a bad authored table is caught, and a duplicate or mistyped item key is the one such
  // fault a redeploy cannot undo — by the time it shows, that key is in somebody's bag.
  const items = validateItemDefinitions(ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS);
  for (const warning of items.warnings) {
    console.warn(`[zep-test] ${warning}`);
  }
  if (items.errors.length > 0) {
    refuseBoot(`invalid item definitions: ${items.errors.join("; ")}`);
  }

  // Last of the four. Portal validation above also reads the item table now (a gated door's
  // requiresItemKey), but this one reads two others besides — a drop line naming an item that is
  // not in the catalogue can only be found out about on a kill.
  const monsters = validateMonsterSpawnDefinitions(
    MONSTER_SPAWN_DEFINITIONS,
    MONSTER_TYPES,
    ITEM_DEFINITIONS,
    mapsByRoom,
    PORTAL_DEFINITIONS,
    INTERACTABLE_DEFINITIONS,
  );
  for (const warning of monsters.warnings) {
    console.warn(`[zep-test] ${warning}`);
  }
  if (monsters.errors.length > 0) {
    refuseBoot(`invalid monster spawn definitions: ${monsters.errors.join("; ")}`);
  }

  const landmarks = validateLandmarkDefinitions(
    LANDMARK_DEFINITIONS,
    LANDMARK_DESCRIPTORS,
    mapsByRoom,
    new Set(ITEM_DEFINITIONS.map((item) => item.key)),
  );
  for (const warning of landmarks.warnings) {
    console.warn(`[zep-test] ${warning}`);
  }
  if (landmarks.errors.length > 0) {
    refuseBoot(`invalid landmark definitions: ${landmarks.errors.join("; ")}`);
  }

  markReady();
}

function refuseBoot(reason: string, cause?: unknown): never {
  markUnhealthy(reason);
  throw cause === undefined ? new Error(reason) : new Error(reason, { cause });
}
