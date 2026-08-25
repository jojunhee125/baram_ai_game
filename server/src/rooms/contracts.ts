import type { Client } from "colyseus";
import type { Direction, RoomState, TilePosition } from "@zep-test/shared";

/**
 * Per-room configuration passed as the third argument of `gameServer.define()`,
 * surfacing in `onCreate(options)`. This is the parameterization point: the room
 * handler class is registered once per room type with a different config, so
 * adding rooms later is a registration change, not a code change.
 */
export interface RoomCreateOptions {
  roomType: string;
  mapKey: string;
  maxClients: number;
  spawn: TilePosition;
}

/** A registered room type. The `name` is the matchmaking name clients join by. */
export interface RoomDefinition extends RoomCreateOptions {
  name: string;
}

/** Data attached to `client.userData`; never synced to clients. */
export interface PlayerSession {
  nickname: string;
  lastMoveAt: number;
  lastChatAt: number;
}

/** Generic argument for `extends Room<...>` in Colyseus 0.17. */
export interface MetaverseRoomOptions {
  state: RoomState;
  client: Client<{ userData: PlayerSession }>;
}

/** Walkability lookup derived from a Tiled collision layer. */
export interface CollisionMap {
  readonly widthInTiles: number;
  readonly heightInTiles: number;
  isWalkable(tileX: number, tileY: number): boolean;
}

/** Resolves a Tiled map file into a server-side collision map. */
export interface MapLoader {
  load(mapKey: string): Promise<CollisionMap>;
}

/** Pure, unit-testable movement rule. Returns null when the step is refused. */
export interface MovementResolver {
  resolveStep(from: TilePosition, dir: Direction, map: CollisionMap): TilePosition | null;
}

/**
 * Radius query over the players currently in the room. Both the StateView sync
 * (VIEW_RADIUS_TILES) and chat delivery (CHAT_RADIUS_TILES) go through this one
 * seam, so the Phase2 500-CCU work can replace the naive scan with a spatial
 * index without touching either caller.
 */
export interface ProximityIndex {
  /** Session ids within `radiusInTiles` of `origin`, including the origin's own player. */
  within(origin: TilePosition, radiusInTiles: number): Iterable<string>;
}
