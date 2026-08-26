import type { Client } from "colyseus";
import type { Direction, RoomState, TilePosition } from "@zep-test/shared";

/**
 * Where a joining client is placed. The tile is the centre of a Chebyshev square with
 * half-extent `spreadRadiusInTiles`, from which a walkable tile is sampled; 0 means every
 * client stands on the centre tile itself, which is what the small rooms rely on.
 */
export interface SpawnArea extends TilePosition {
  spreadRadiusInTiles: number;
}

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
  spawn: SpawnArea;
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

/**
 * `onAuth`'s return value from `ssoNickname` — never `string | null` directly: Colyseus
 * treats a falsy `onAuth` result as authentication failure and rejects the join, so the
 * "no SSO" case (local dev, tests) must still be a truthy object.
 */
export interface AuthResult {
  ssoNickname: string | null;
}

/** Generic argument for `extends Room<...>` in Colyseus 0.17. */
export interface MetaverseRoomOptions {
  state: RoomState;
  client: Client<{ userData: PlayerSession; auth: AuthResult }>;
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
 * (VIEW_RADIUS_TILES) and chat delivery (CHAT_RADIUS_TILES) go through this one seam.
 *
 * The index holds its *own copy* of every player's position, so the room has to report
 * every position change: one missed `move()` freezes that player as permanently invisible
 * to their neighbours, or permanently visible. It is the kind of fault that breaks quietly.
 */
export interface ProximityIndex {
  /**
   * Fills `out` with the session ids within Chebyshev distance `radiusInTiles` of `origin`
   * and returns it, including the player standing on `origin` itself.
   *
   * `out` is cleared first and stays caller-owned — never hand the same array to two
   * queries whose results have to be alive at the same time.
   */
  within(origin: TilePosition, radiusInTiles: number, out: string[]): string[];

  /** Registers a player at their spawn tile. */
  insert(sessionId: string, position: TilePosition): void;

  /** Moves an already-registered player. No-op for an unknown session id. */
  move(sessionId: string, position: TilePosition): void;

  /** Drops a player. Idempotent. */
  remove(sessionId: string): void;
}
