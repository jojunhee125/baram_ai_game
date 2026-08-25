import { createServer } from "node:http";
import { Server, WebSocketTransport } from "colyseus";
import { TiledMapLoader } from "./game/tiledMap";
import { markReady, markUnhealthy } from "./http/readiness";
import { configureHttpRoutes } from "./http/routes";
import { observeWebSocketUpgrade } from "./http/wsAuthProbe";
import { ROOM_DEFINITIONS } from "./rooms/definitions";
import { MetaverseRoom } from "./rooms/metaverseRoom";

export const DEFAULT_PORT = 2567;

export function createGameServer(): Server {
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
 */
async function validateRoomMaps(): Promise<void> {
  const loader = new TiledMapLoader();
  for (const mapKey of new Set(ROOM_DEFINITIONS.map((definition) => definition.mapKey))) {
    try {
      await loader.load(mapKey);
    } catch (cause) {
      const reason = `map "${mapKey}" failed to load`;
      markUnhealthy(reason);
      throw new Error(reason, { cause });
    }
  }
  markReady();
}
