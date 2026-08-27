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

/**
 * A one-way link from trigger tiles in one room to an arrival point in another: the portal /
 * door object of roadmap item 3. Authored in code beside `ROOM_DEFINITIONS` rather than in the
 * map file, because the destination is a matchmaking room name — a concept map data has no
 * word for. Rationale and the rejected map-embedded alternative: `docs/design-portal-object.md`.
 *
 * One-way by construction. A door you can walk back through is two rows, which is what lets
 * the two sides have different arrival tiles.
 */
export interface PortalDefinition {
  /**
   * Stable unique key, e.g. `"plaza-north-door"`. It crosses the wire both ways
   * (`PortalEntered.portalId`, `JoinOptions.viaPortal`), so it must not be a table index:
   * reordering the rows would silently reroute a client that is mid-transition.
   *
   * Untrusted on the way back in, but it is only ever a lookup key — never a path or a query —
   * so an unknown value needs no sanitising, just the documented spawn fallback.
   */
  id: string;
  from: PortalSource;
  to: PortalTarget;
}

/** Where a portal is entered. */
export interface PortalSource {
  /** Matchmaking name of the room holding the trigger tiles — a {@link RoomDefinition} `name`. */
  room: string;
  /**
   * Every tile that fires this portal, so a two-tile-wide doorway is one portal instead of two
   * rows that have to be kept in step. Must be non-empty, and every tile must be walkable: an
   * unwalkable trigger can never be stepped onto, which is a portal that silently does nothing.
   */
  tiles: readonly TilePosition[];
}

/** Where a portal comes out. */
export interface PortalTarget {
  /** Matchmaking name of the destination room — a {@link RoomDefinition} `name`. */
  room: string;
  /**
   * Arrival placement, a {@link SpawnArea} so that one sampler serves both this and the
   * room's own spawn. The arrival belongs to the portal, not to the room, which is how several
   * portals can land in the same room at different spots while `RoomDefinition.spawn` stays a
   * single value.
   *
   * `spreadRadiusInTiles: 0` is the normal choice — a doorway wants a determinate tile — but a
   * door into a 500-client room can spread rather than pile everyone onto one tile.
   */
  arrival: SpawnArea;
}

/**
 * One room's view of the portal graph, narrowed from the whole table at `onCreate`.
 *
 * Two lookups because a room sits on both ends of the graph: it fires the portals that leave
 * it, and it places the clients arriving through the portals that point at it. Neither lookup
 * needs the rest of the table, and a room that appears in no row gets an index that answers
 * null to everything — which is exactly what a test room or an unnamed room instance wants.
 */
export interface PortalIndex {
  /**
   * The portal fired by a move that just landed on this tile, or null.
   *
   * Runs on every accepted move, so an implementation must not allocate — in particular no
   * `` `${tileX},${tileY}` `` map keys, which at the target load is per-move garbage on the
   * hottest path in the room.
   */
  triggerAt(tileX: number, tileY: number): PortalDefinition | null;

  /**
   * Where a client joining with `JoinOptions.viaPortal` belongs, or null when this room is not
   * that portal's destination — an unknown id, or one belonging to a door into another room.
   *
   * Null means "place them at the room's generic spawn", never "refuse the join".
   */
  arrivalFor(portalId: string): SpawnArea | null;
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
