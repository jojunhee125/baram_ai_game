import { createServer } from "node:http";
import { Encoder } from "@colyseus/schema";
import { Server, WebSocketTransport } from "colyseus";
import { validateInteractableDefinitions } from "./game/interactables";
import { validatePortalDefinitions } from "./game/portals";
import { TiledMapLoader } from "./game/tiledMap";
import { markReady, markUnhealthy } from "./http/readiness";
import { configureHttpRoutes } from "./http/routes";
import { observeWebSocketUpgrade } from "./http/wsAuthProbe";
import type { CollisionMap } from "./rooms/contracts";
import { ROOM_DEFINITIONS } from "./rooms/definitions";
import { INTERACTABLE_DEFINITIONS } from "./rooms/interactableDefinitions";
import { MetaverseRoom } from "./rooms/metaverseRoom";
import { PORTAL_DEFINITIONS } from "./rooms/portalDefinitions";

export const DEFAULT_PORT = 2567;

export function createGameServer(): Server {
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

  // Read-only. `ws` owns this event too and completes the handshake from its own
  // listener; touching the socket here would break it.
  httpServer.on("upgrade", (request) => {
    observeWebSocketUpgrade(request.headers);
  });

  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    express: configureHttpRoutes,
    beforeListen: validateRoomMaps,
  });

  for (const definition of ROOM_DEFINITIONS) {
    gameServer.define(definition.name, MetaverseRoom, definition);
  }
  return gameServer;
}

export function resolvePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
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

  const { errors, warnings } = validatePortalDefinitions(PORTAL_DEFINITIONS, mapsByRoom);
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
  );
  for (const warning of objects.warnings) {
    console.warn(`[zep-test] ${warning}`);
  }
  if (objects.errors.length > 0) {
    refuseBoot(`invalid interactable definitions: ${objects.errors.join("; ")}`);
  }

  markReady();
}

function refuseBoot(reason: string, cause?: unknown): never {
  markUnhealthy(reason);
  throw cause === undefined ? new Error(reason) : new Error(reason, { cause });
}
