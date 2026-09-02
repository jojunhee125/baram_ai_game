import type { Client } from "colyseus";
import type { InventoryStore } from "../db/inventoryStore";
// `InteractableKind` is imported as a value, not just as a type: the authored table's
// discriminant and the wire union's have to be the same string, so both read it from one place.
import {
  InteractableKind,
  type Direction,
  type RoomState,
  type TilePosition,
} from "@zep-test/shared";

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
  /**
   * Where a kill's drops are filed. The one live dependency among these otherwise static fields,
   * injected at the `define()` call rather than authored in `ROOM_DEFINITIONS`, so the table stays
   * data and the same store instance serves both the rooms and `GET /api/inventory` — two stores
   * would mean drops that the bag window cannot see.
   *
   * Optional because the tests, the load-test harness and `npm run dev` all build rooms without
   * one; a room with no store still fights, it just credits nothing. Not a hole a client can climb
   * through, despite `onCreate` seeing the join options of whoever created the room: Colyseus
   * merges the handler's options *over* the client's, so a fabricated `inventoryStore` key is
   * overwritten by whatever was registered — including by `undefined`.
   */
  inventoryStore?: InventoryStore;
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

  /**
   * Every tile that fires a portal leaving this room, for populating `RoomState.portalMarkers`
   * at `onCreate` — the only reason this exists is to give the client something to draw. A
   * duplicate entry (two portals sharing a trigger tile) is fine to emit twice; the client just
   * draws the same marker twice on the same tile.
   */
  triggerTiles(): readonly TilePosition[];
}

/**
 * A fixed interactive object of roadmap item 3: the author places it on tiles and fills in its
 * content, and the step that enters one of those tiles opens the matching panel.
 *
 * Authored in code beside `PORTAL_DEFINITIONS`, for that table's reasons
 * (`docs/design-portal-object.md` §1) and one of its own: both maps are machine-generated, so
 * content embedded in a map file is deleted by the next regeneration without a word. The rejected
 * alternative — a runtime admin API behind `kad.roles` — is argued in
 * `docs/design-fixed-objects.md` §2.
 *
 * Three fixed shapes rather than one row with a free-form payload: a closed set of object types
 * instead of a scripting engine is the whole of item 3 (project CLAUDE.md, "Out of Scope").
 */
export type InteractableDefinition = LinkInteractable | NoticeInteractable | QuizInteractable;

/** What every object row carries, whatever its kind. */
interface InteractableBase {
  /**
   * Stable key, unique across the whole table. It crosses the wire as
   * `InteractableEntered.objectId` and returns as `QuizAnswerRequest.objectId`, so — like a
   * portal id — it must not be a table index, and it needs no sanitising on the way back in:
   * it is only ever a lookup key, and an unknown one resolves to null.
   */
  id: string;
  at: InteractableSource;
  /** Panel heading. */
  title: string;
}

/** Where an object is triggered. */
export interface InteractableSource {
  /** Matchmaking name of the room holding the tiles — a {@link RoomDefinition} `name`. */
  room: string;
  /**
   * Every tile that opens this object, so a wide signboard is one row rather than several kept
   * in step. Must be non-empty and every tile walkable, and no tile may be shared with another
   * object or with a portal trigger: two things firing on one step is a panel opening into a room
   * that is already leaving. Boot refuses all of those.
   */
  tiles: readonly TilePosition[];
}

export interface LinkInteractable extends InteractableBase {
  kind: typeof InteractableKind.Link;
  /** Absolute URL; boot refuses any scheme but `http:` / `https:`. Opened in a new tab. */
  url: string;
}

export interface NoticeInteractable extends InteractableBase {
  kind: typeof InteractableKind.Notice;
  /**
   * The notice text; newlines are significant. Author-written and static — this is a board, not
   * a guestbook. Player-written entries need storage that outlives a room instance, and this
   * project has no database at all; see `docs/design-fixed-objects.md` §3.
   */
  body: string;
}

export interface QuizInteractable extends InteractableBase {
  kind: typeof InteractableKind.Quiz;
  question: string;
  /** Two or more, in display order. */
  choices: readonly string[];
  /** Index into {@link QuizInteractable.choices}. Never leaves the server: the client sends a choice and is told. */
  answerIndex: number;
  /** Optional note shown with the verdict, right or wrong. */
  explanation?: string;
}

/**
 * One room's view of the object table, narrowed from the whole table at `onCreate` — the
 * {@link PortalIndex} arrangement, for the same reason: a room only ever needs its own rows, and
 * a room named in no row gets an index that answers null to everything.
 *
 * Kept as its own interface rather than making this and {@link PortalIndex} instances of one
 * generic tile index. What the two share is a fifteen-line constructor loop; the payloads and the
 * second lookup are not shared at all, and merging them would mean rewriting the portal trigger
 * path, which is deployed and covered by tests, for no behaviour. Worth revisiting only if a
 * third trigger table appears.
 */
export interface InteractableIndex {
  /**
   * The object opened by a move that just landed on this tile, or null.
   *
   * Runs on every accepted move, immediately behind {@link PortalIndex.triggerAt}, so the same
   * rule applies: no allocation, and in particular no `` `${tileX},${tileY}` `` lookup keys.
   */
  at(tileX: number, tileY: number): InteractableDefinition | null;

  /**
   * The object a client named in `QuizAnswerRequest`, or null when this room holds no such row —
   * an unknown id, or one belonging to an object in another room.
   *
   * Null means "ignore the message": there is no interaction state to correct and nothing the
   * client could usefully be told.
   */
  byId(objectId: string): InteractableDefinition | null;

  /**
   * Every tile of every object in this room, paired with its kind, for populating
   * `RoomState.interactableMarkers` at `onCreate`. This is the only way the client learns an
   * object's position; its content still arrives only on the step that enters the tile.
   */
  markerTiles(): readonly InteractableMarkerTile[];
}

/** One entry of {@link InteractableIndex.markerTiles}. */
export interface InteractableMarkerTile extends TilePosition {
  kind: InteractableKind;
}

/**
 * One thing a player can be carrying: the item catalogue of roadmap item 7
 * (`docs/design-hunting-inventory.md` §3.2). Authored in code beside `PORTAL_DEFINITIONS` and
 * `INTERACTABLE_DEFINITIONS`, and for the same reason — the deploy is the edit permission.
 *
 * The database stores only {@link ItemDefinition.key} and an amount, so the display strings below
 * are not duplicated there: a name in two places is a name that will disagree with itself, and
 * renaming an item has to stay a deploy rather than a migration.
 */
export interface ItemDefinition {
  /**
   * Stable key, unique across the table. It is written into `inventory_item.item_key` and read
   * back on every bag open, so — like a portal id — it must never be a table index: reordering
   * the rows would rename everything already in every player's bag.
   */
  key: string;
  name: string;
  /**
   * Client-side icon key, sent with the item rather than looked up in the bundle, so a client
   * older than the server still draws the row it was handed. It selects a frame of `items.png`
   * by its position in `ITEM_ICON_ORDER` (design appendix D-3).
   *
   * Its own field rather than a reuse of {@link ItemDefinition.key}, even while every row sets
   * the two to the same string: art is allowed to be shared between items and a `key` is not
   * allowed to move, so the day one icon serves two items must not become a question about the
   * database.
   */
  icon: string;
}

/** Data attached to `client.userData`; never synced to clients. */
export interface PlayerSession {
  nickname: string;
  lastMoveAt: number;
  lastChatAt: number;
  /**
   * Server clock of the last accepted return-home request. Separate from `lastMoveAt` on
   * purpose: a warp costs O(room population) where a step costs O(neighbours), so the two
   * need different budgets and sharing one counter would let a walk buy a warp. See
   * HOME_COOLDOWN_MS.
   */
  lastHomeAt: number;
  /**
   * Server clock of the last accepted attack, a third counter for `lastHomeAt`'s reason: walking
   * must not buy a swing. See ATTACK_COOLDOWN_MS.
   */
  lastAttackAt: number;
  /**
   * Health, which is never in `RoomState` — nobody sees anybody else's number, and a field on the
   * schema would patch every viewer in range on every hit. Full at join and after every room
   * change, so no message is needed to establish it; it travels only as `PlayerHit`.
   */
  hp: number;
  /**
   * Server clock of the last hit taken; COMBAT_EXIT_MS is measured from it, and 0 means never hit.
   * "Taken", not "dealt" — attacking something does not keep you in combat, being attacked does.
   */
  lastDamagedAt: number;
  /**
   * The account this session's drops are filed under, taken from the SSO token at `onAuth`, and
   * null everywhere there is no SSO. Null is not a refusal: a grant then goes to the in-memory
   * store under the session id instead, which is what keeps the whole drop path — including the
   * `ItemGranted` toast — exercisable in local development.
   */
  ownerKey: string | null;
}

/**
 * `onAuth`'s return value — an object rather than the nullable strings inside it, because
 * Colyseus treats a falsy `onAuth` result as an authentication failure and rejects the join, so
 * the "no SSO" case (local dev, tests) still has to answer something truthy.
 */
export interface AuthResult {
  ssoNickname: string | null;
  /**
   * The `sub` claim, which is the key everything persisted is filed under. Read here rather than
   * later because the access token is only in reach during the handshake.
   */
  ssoUserId: string | null;
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
