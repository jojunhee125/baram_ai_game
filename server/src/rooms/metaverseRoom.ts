import { StateView } from "@colyseus/schema";
import { Room, type AuthContext } from "colyseus";
import {
  AVATAR_SKIN_COUNT,
  CHAT_RADIUS_TILES,
  ClientMessage,
  Direction,
  HOME_COOLDOWN_MS,
  InteractableKind,
  InteractableMarker,
  MAX_CHAT_LENGTH,
  MAX_CHATS_PER_SECOND,
  MAX_MOVES_PER_SECOND,
  MAX_NICKNAME_LENGTH,
  MONSTER_TICK_MS,
  Monster,
  PATCH_RATE_MS,
  Player,
  PortalMarker,
  RoomState,
  ServerMessage,
  VIEW_RADIUS_TILES,
  type ChatBroadcast,
  type ChatRequest,
  type InteractableEntered,
  type JoinOptions,
  type MoveRejected,
  type MoveRequest,
  type PortalEntered,
  type QuizAnswerRequest,
  type QuizResult,
  type Teleported,
  type TilePosition,
} from "@zep-test/shared";
import { TableInteractableIndex } from "../game/interactables";
import {
  decideMonsterAction,
  MonsterActionKind,
  MonsterAiState,
  type MonsterSnapshot,
  type MonsterTarget,
} from "../game/monsterAi";
import { isDirection, TileMovementResolver } from "../game/movement";
import { TablePortalIndex } from "../game/portals";
import { chebyshevDistance, UniformGridProximityIndex } from "../game/proximity";
import { TiledMapLoader } from "../game/tiledMap";
import type {
  AuthResult,
  CollisionMap,
  InteractableDefinition,
  InteractableIndex,
  MetaverseRoomOptions,
  PortalIndex,
  ProximityIndex,
  RoomCreateOptions,
  SpawnArea,
} from "./contracts";
import { INTERACTABLE_DEFINITIONS } from "./interactableDefinitions";
import {
  MONSTER_SPAWN_DEFINITIONS,
  MONSTER_TYPES,
  type MonsterKind,
  type MonsterSpawnDefinition,
  type MonsterType,
} from "./monsterDefinitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";
import { deriveSsoNickname } from "./ssoIdentity";

type RoomClient = MetaverseRoomOptions["client"];

const MIN_MOVE_INTERVAL_MS = 1000 / MAX_MOVES_PER_SECOND;
const MIN_CHAT_INTERVAL_MS = 1000 / MAX_CHATS_PER_SECOND;

/** Colyseus disconnects past this. Legitimate play peaks at 22 msg/s; the rest is burst headroom. */
const MAX_MESSAGES_PER_SECOND = 60;

/** Retry cap for spawn rejection sampling; past it the centre tile is used, which boot validates. */
const SPAWN_SAMPLE_ATTEMPTS = 16;

/**
 * Grid cell size for the proximity index. One more than the view radius because that is the
 * widest query the room issues (the move scan in {@link MetaverseRoom.refreshViewsAround}),
 * and it is the smallest cell for which such a query spans only 3x3 cells.
 *
 * A home warp breaks that premise — the same scan then queries `VIEW_RADIUS_TILES + warp
 * distance`, which across grand-plaza spans the whole grid. Answers stay exact; only the 3x3
 * cost bound is lost, which is what HOME_COOLDOWN_MS budgets for.
 */
const PROXIMITY_CELL_SIZE_TILES = VIEW_RADIUS_TILES + 1;

/**
 * Everything about one monster that is not in `state.monsters`: its rules, its FSM state and its
 * deadlines. Kept off the schema on purpose — none of it is anybody's business on the client, and
 * a field on the schema is a patch to every viewer within the radius each time it changes.
 *
 * There is one entry per spawn row for the room's whole life, alive or dead; `state.monsters`
 * holds only the living, so the two are read together.
 */
interface MonsterRuntime {
  readonly definition: MonsterSpawnDefinition;
  readonly type: MonsterType;
  state: MonsterAiState;
  nextStepAt: number;
  nextAttackAt: number;
  /** Only meaningful in the dead state. */
  respawnAt: number;
}

export class MetaverseRoom extends Room<MetaverseRoomOptions> {
  private readonly mapLoader = new TiledMapLoader();
  private readonly movementResolver = new TileMovementResolver();
  /** Session ids currently added to each client's StateView, keyed by viewer session id. */
  private readonly viewedBySession = new Map<string, Set<string>>();
  /**
   * sessionId -> client. Colyseus' `clients.getById()` is a `ClientArray#find`, so calling it
   * inside a neighbour loop multiplies the per-move cost by the room population again.
   */
  private readonly clientsBySession = new Map<string, RoomClient>();
  /** Sessions already told about the current throttled burst, so one burst yields one notice. */
  private readonly moveThrottleNotified = new Set<string>();
  /**
   * Scratch buffers, reused instead of reallocated: at the target load these queries run tens
   * of thousands of times a second and a fresh array each time is pure young-gen garbage.
   *
   * Each buffer belongs to exactly one query site, because a buffer may not be handed to a
   * second query while the first result is still being iterated.
   */
  private readonly neighbourBuffer: string[] = [];
  private readonly viewQueryBuffer: string[] = [];
  private readonly chatBuffer: string[] = [];
  private readonly inRange = new Set<string>();
  /**
   * False for every room with no monster row, which is every room but the hunting ground today.
   * Reading one boolean is the entire cost this feature puts on grand-plaza's move path, and that
   * is deliberate: PoC #2's measurements are the baseline this must not move.
   */
  private hasMonsters = false;
  /** Monster-only proximity index. Same class as the player one, separate instance. */
  private monsterIndex!: ProximityIndex;
  /** Per spawn row, alive or dead. See {@link MonsterRuntime}. */
  private readonly monsterRuntimes = new Map<string, MonsterRuntime>();
  /** Monster ids in each client's StateView. The monster half of {@link viewedBySession}. */
  private readonly monstersViewedBySession = new Map<string, Set<string>>();
  /**
   * Monsters have their own scratch buffers for the same reason the players do — one buffer per
   * query site — and they cannot borrow the player ones: "monsters near this player" and "players
   * near this monster" are different questions asked from different places, and a shared buffer
   * would be overwritten while the first answer was still being read.
   */
  private readonly monsterQueryBuffer: string[] = [];
  private readonly monsterNeighbourBuffer: string[] = [];
  private readonly monsterAggroBuffer: string[] = [];
  private readonly monstersInRange = new Set<string>();
  /** Rebuilt per monster per tick; the array itself is reused, the entries are not worth pooling. */
  private readonly monsterTargets: MonsterTarget[] = [];
  private collisionMap!: CollisionMap;
  private proximityIndex!: ProximityIndex;
  private portalIndex!: PortalIndex;
  private interactableIndex!: InteractableIndex;
  private spawn!: SpawnArea;
  /**
   * Where "return home" lands: the spawn centre with the spawn's spread deliberately dropped.
   *
   * Home has to be one determinate tile — a player who warps twice and lands somewhere else
   * each time has not gone home. That is the opposite of what the spread is for on join, so
   * this cannot just reuse {@link spawn}: grand-plaza spreads over radius 70.
   */
  private home!: SpawnArea;

  async onCreate(options: RoomCreateOptions): Promise<void> {
    this.state = new RoomState();
    this.state.roomType = options.roomType;
    this.state.mapKey = options.mapKey;
    this.maxClients = options.maxClients;
    this.spawn = options.spawn;
    this.home = { tileX: options.spawn.tileX, tileY: options.spawn.tileY, spreadRadiusInTiles: 0 };
    this.setPatchRate(PATCH_RATE_MS);
    this.maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

    this.collisionMap = await this.mapLoader.load(options.mapKey);
    this.proximityIndex = this.createProximityIndex(this.collisionMap);
    this.portalIndex = this.createPortalIndex(this.collisionMap);
    this.interactableIndex = this.createInteractableIndex(this.collisionMap);
    // Static for the room's lifetime — populated once here, never touched again. This is the
    // only reason the client learns a portal's position at all (never its id or destination).
    for (const tile of this.portalIndex.triggerTiles()) {
      this.state.portalMarkers.push(new PortalMarker(tile));
    }
    // Position and kind only. An object's content never enters the state — it would be a static
    // broadcast to every client that buys nothing, and it would put the quiz answers on the wire.
    for (const tile of this.interactableIndex.markerTiles()) {
      this.state.interactableMarkers.push(new InteractableMarker(tile));
    }

    this.populateMonsters();

    this.onMessage(ClientMessage.Move, (client: RoomClient, message: MoveRequest) => {
      this.handleMove(client, message);
    });
    this.onMessage(ClientMessage.Chat, (client: RoomClient, message: ChatRequest) => {
      this.handleChat(client, message);
    });
    this.onMessage(ClientMessage.ReturnHome, (client: RoomClient) => {
      this.handleReturnHome(client);
    });
    this.onMessage(ClientMessage.QuizAnswer, (client: RoomClient, message: QuizAnswerRequest) => {
      this.handleQuizAnswer(client, message);
    });

    // Last, and only where there is something to simulate. A room with no monsters stays purely
    // message-driven, which is what it was before this feature existed. Colyseus disposes an
    // empty room, so monster state is never persisted either — the last player to leave resets
    // the health of whatever they were fighting, which is the documented specification.
    if (this.state.monsters.size > 0) {
      this.setSimulationInterval(() => {
        this.tick(Date.now());
      }, MONSTER_TICK_MS);
    }
  }

  /** Overridable seam: a test subclass wraps the index to assert per-move query counts. */
  protected createProximityIndex(map: CollisionMap): ProximityIndex {
    return new UniformGridProximityIndex(
      map.widthInTiles,
      map.heightInTiles,
      PROXIMITY_CELL_SIZE_TILES,
    );
  }

  /**
   * Overridable seam, the monster twin of {@link createProximityIndex}: a test subclass wraps it
   * to prove a room without monsters never queries it — never builds it, in fact, since
   * {@link populateMonsters} only calls this when the room owns at least one spawn row.
   */
  protected createMonsterIndex(map: CollisionMap): ProximityIndex {
    return new UniformGridProximityIndex(
      map.widthInTiles,
      map.heightInTiles,
      PROXIMITY_CELL_SIZE_TILES,
    );
  }

  /**
   * Overridable seam: a test subclass injects a hand-built table instead of the real one.
   *
   * Narrowed by `this.roomName`, exactly as the portal and object indexes are, and with the same
   * consequence — a room whose name is in no row (including a room built without the matchmaker,
   * which is how the view tests build one) simply has no monsters.
   */
  protected monsterSpawns(): readonly MonsterSpawnDefinition[] {
    if (this.roomName === undefined) {
      return [];
    }
    return MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === this.roomName);
  }

  /** Overridable seam, paired with {@link monsterSpawns} so a fixture can bring its own kinds. */
  protected monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return MONSTER_TYPES;
  }

  /**
   * Overridable seam: a test subclass injects a hand-built table instead of the real one.
   *
   * `this.roomName` is the room's matchmaking name, and a name in no row of the table — or the
   * runtime-undefined name of a room built without the matchmaker — yields an index that
   * answers null to everything. That is the normal path for a room with no doors, not an error,
   * so nothing is asserted about it here.
   */
  protected createPortalIndex(map: CollisionMap): PortalIndex {
    return new TablePortalIndex(this.roomName, PORTAL_DEFINITIONS, map);
  }

  /**
   * Overridable seam, for the reason {@link createPortalIndex} gives: a room whose name matches no
   * row — including the runtime-undefined name of a room built without the matchmaker — gets an
   * index that answers null to everything, which is the normal path for a room with no objects.
   */
  protected createInteractableIndex(map: CollisionMap): InteractableIndex {
    return new TableInteractableIndex(this.roomName, INTERACTABLE_DEFINITIONS, map);
  }

  /**
   * Always returns a truthy object — see {@link AuthResult}. `ssoNickname` is null outside
   * SSO (local dev, tests), and `onJoin` then falls back to `options.nickname`.
   */
  onAuth(_client: RoomClient, _options: JoinOptions | undefined, context: AuthContext): AuthResult {
    return { ssoNickname: deriveSsoNickname(context.headers) };
  }

  onJoin(client: RoomClient, options?: JoinOptions): void {
    const nickname = normalizeNickname(client.auth?.ssoNickname ?? options?.nickname);
    if (nickname === null) {
      throw new Error("nickname is required");
    }

    // An id this room does not own — unknown, or one belonging to a door out of this room —
    // falls back to the generic spawn rather than refusing the join, which would strand a
    // client whose portal row changed while its tab was open.
    const viaPortal = typeof options?.viaPortal === "string" ? options.viaPortal : undefined;
    const arrival = viaPortal === undefined ? null : this.portalIndex.arrivalFor(viaPortal);
    // Portal beats home: it is the more specific request, and the only one of the two the
    // server itself issued. An unowned portal id falls through to home if home was asked for,
    // not to the spawn — the client asked for two things and only one of them was rejected.
    const area = arrival ?? (options?.arriveAtHome === true ? this.home : this.spawn);

    const spawnTile = this.pickSpawnTile(area);
    this.state.players.set(
      client.sessionId,
      new Player({
        nickname,
        tileX: spawnTile.tileX,
        tileY: spawnTile.tileY,
        facing: Direction.Down,
        avatarSkin: normalizeAvatarSkin(options?.avatarSkin),
      }),
    );
    this.proximityIndex.insert(client.sessionId, spawnTile);
    client.userData = { nickname, lastMoveAt: 0, lastChatAt: 0, lastHomeAt: 0 };
    client.view = new StateView();
    this.viewedBySession.set(client.sessionId, new Set());
    this.clientsBySession.set(client.sessionId, client);

    this.refreshViewsAround(client.sessionId, null, spawnTile);
    if (this.hasMonsters) {
      this.monstersViewedBySession.set(client.sessionId, new Set());
      this.refreshMonsterViewFor(client.sessionId);
    }
  }

  onLeave(client: RoomClient): void {
    const player = this.state.players.get(client.sessionId);
    // The leaver's tile has to be read before the `state.players` deletion below. Where the
    // call itself sits among the deletions does not matter: `to` null makes it touch only the
    // neighbours' bookkeeping, and the neighbour query reaches them by position — the leaver's
    // own index entry is skipped (`viewerId === sessionId`) whether or not it is still there.
    if (player) {
      this.refreshViewsAround(client.sessionId, { tileX: player.tileX, tileY: player.tileY }, null);
    }
    this.proximityIndex.remove(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.viewedBySession.delete(client.sessionId);
    // Not gated on `hasMonsters`: a delete against an empty Map is cheaper than the branch, and
    // leaving this behind would leak a Set per session for the room's whole life.
    this.monstersViewedBySession.delete(client.sessionId);
    this.clientsBySession.delete(client.sessionId);
    this.moveThrottleNotified.delete(client.sessionId);
  }

  private handleMove(client: RoomClient, message: MoveRequest): void {
    const session = client.userData;
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) {
      return;
    }

    const dir = message?.dir;
    if (!isDirection(dir)) {
      return;
    }

    const now = Date.now();
    if (now - session.lastMoveAt < MIN_MOVE_INTERVAL_MS) {
      // The throttled move is dropped whole, so facing does not change either. Without
      // this correction a client whose input burst got throttled (a refocused tab
      // flushing queued moves) would stay mispredicted until its next accepted move.
      if (!this.moveThrottleNotified.has(client.sessionId)) {
        this.moveThrottleNotified.add(client.sessionId);
        client.send(ServerMessage.MoveRejected, {
          tileX: player.tileX,
          tileY: player.tileY,
          facing: player.facing as Direction,
        } satisfies MoveRejected);
      }
      return;
    }
    this.moveThrottleNotified.delete(client.sessionId);
    session.lastMoveAt = now;

    // A refused step still turns the player: facing a wall is normal, and the
    // client needs the turn even when the position does not change.
    player.facing = dir;

    const destination = this.movementResolver.resolveStep(
      { tileX: player.tileX, tileY: player.tileY },
      dir,
      this.collisionMap,
    );
    if (destination === null) {
      client.send(ServerMessage.MoveRejected, {
        tileX: player.tileX,
        tileY: player.tileY,
        facing: dir,
      } satisfies MoveRejected);
      return;
    }

    const from = { tileX: player.tileX, tileY: player.tileY };
    player.tileX = destination.tileX;
    player.tileY = destination.tileY;
    // Index first: `refreshViewsAround` finishes by rebuilding the mover's own view from an
    // index query, and a stale entry at `from` would drop the mover out of its own view. A
    // one-tile step masks that — `from` is inside the mover's own view radius either way, so
    // swapping these two lines fails no test today — but a warp step would break it.
    this.proximityIndex.move(client.sessionId, destination);
    this.refreshViewsAround(client.sessionId, from, destination);
    // The mover's own origin shifted, so its monster view has to be recomputed too — the same
    // reason `refreshViewsAround` finishes by recomputing its player view. The guard, not a
    // branch inside the shared code, is what keeps a monsterless room on its old path.
    if (this.hasMonsters) {
      this.refreshMonsterViewFor(client.sessionId);
    }

    // Last, strictly after the index and view bookkeeping above: a throw on this path must not
    // leave that bookkeeping half-applied, which is the failure that makes a player permanently
    // invisible (or permanently visible) to their neighbours.
    const portal = this.portalIndex.triggerAt(destination.tileX, destination.tileY);
    if (portal !== null) {
      client.send(ServerMessage.PortalEntered, {
        portalId: portal.id,
        toRoom: portal.to.room,
      } satisfies PortalEntered);
    }

    // Behind the portal check for readability only: boot refuses a table that puts an object on a
    // portal trigger, so at most one of the two can ever fire on the same step.
    const object = this.interactableIndex.at(destination.tileX, destination.tileY);
    if (object !== null) {
      client.send(ServerMessage.InteractableEntered, toInteraction(object));
    }
  }

  private handleChat(client: RoomClient, message: ChatRequest): void {
    const session = client.userData;
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) {
      return;
    }

    const text = typeof message?.text === "string" ? message.text.trim() : "";
    if (text.length === 0 || text.length > MAX_CHAT_LENGTH) {
      return;
    }

    const now = Date.now();
    if (now - session.lastChatAt < MIN_CHAT_INTERVAL_MS) {
      return;
    }
    session.lastChatAt = now;

    const broadcast: ChatBroadcast = {
      sessionId: client.sessionId,
      nickname: session.nickname,
      text,
      at: now,
    };
    const audience = this.proximityIndex.within(player, CHAT_RADIUS_TILES, this.chatBuffer);
    for (const sessionId of audience) {
      this.clientsBySession.get(sessionId)?.send(ServerMessage.Chat, broadcast);
    }
  }

  /**
   * Puts the player back on the room's home tile. The only non-adjacent position change the
   * room performs, which is what makes the two invariants below load-bearing rather than latent.
   */
  private handleReturnHome(client: RoomClient): void {
    const session = client.userData;
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) {
      return;
    }

    const now = Date.now();
    if (now - session.lastHomeAt < HOME_COOLDOWN_MS) {
      // Dropped in silence, unlike a throttled move: the client mirrors this window as the
      // button's disabled period, so anything arriving inside it is a duplicate rather than a
      // misprediction to correct — and the player is already standing where it would send them.
      return;
    }
    session.lastHomeAt = now;

    const destination = this.pickSpawnTile(this.home);
    const from = { tileX: player.tileX, tileY: player.tileY };
    player.tileX = destination.tileX;
    player.tileY = destination.tileY;
    // Same convention as the first placement in onJoin: an arrival has no direction of travel
    // to inherit, and keeping the pre-warp facing would point the avatar back at a tile it is
    // no longer next to.
    player.facing = Direction.Down;
    // Index strictly before the view refresh. handleMove says a one-tile step masks the
    // ordering; this is the path it warned about — `from` is normally outside the destination's
    // view radius, so a stale index entry drops the warper out of their own rebuilt view.
    this.proximityIndex.move(client.sessionId, destination);
    this.refreshViewsAround(client.sessionId, from, destination);
    if (this.hasMonsters) {
      this.refreshMonsterViewFor(client.sessionId);
    }

    // Sent even though the state patch carries the same position: a client with steps in
    // flight ignores its own position patches, so a warp landing mid-walk would be swallowed.
    client.send(ServerMessage.Teleported, {
      tileX: destination.tileX,
      tileY: destination.tileY,
      facing: Direction.Down,
    } satisfies Teleported);
  }

  /**
   * Grades one quiz answer and remembers nothing: no score, no attempt count, no interaction
   * state to clean up if the client vanishes mid-question.
   *
   * Deliberately does not check that the player is standing on the object's tile. Nothing is
   * scored, so there is no advantage to deny, and the check would create a failure mode of its
   * own — an answer sent as the player steps off the tile would vanish in silence. The
   * room-narrowed index is already the boundary that stops an id from another room resolving.
   *
   * Deliberately has no rate limit of its own either. Chat needed one because it fans out O(k),
   * and the home warp because it queries O(room population); this is one `Map` lookup and one
   * unicast, the same grade as a MoveRejected, and `maxMessagesPerSecond` already caps it.
   */
  private handleQuizAnswer(client: RoomClient, message: QuizAnswerRequest): void {
    const player = this.state.players.get(client.sessionId);
    if (!client.userData || !player) {
      return;
    }

    const objectId = message?.objectId;
    if (typeof objectId !== "string") {
      return;
    }
    // Null for an unknown id or one belonging to another room's object; a non-quiz object is a
    // client asking a signboard for a verdict. Neither has anything useful to be told.
    const object = this.interactableIndex.byId(objectId);
    if (object === null || object.kind !== InteractableKind.Quiz) {
      return;
    }

    const { choiceIndex } = message;
    if (typeof choiceIndex !== "number" || !Number.isInteger(choiceIndex)) {
      return;
    }

    // An out-of-range index is graded wrong rather than ignored: unlike a malformed payload, it
    // came from a client that is waiting for a verdict, and silence would strand its panel.
    client.send(ServerMessage.QuizResult, {
      objectId: object.id,
      choiceIndex,
      correct: choiceIndex === object.answerIndex,
      explanation: object.explanation,
    } satisfies QuizResult);
  }

  /**
   * A walkable tile within `area.spreadRadiusInTiles` of `area`'s centre. Spreading matters
   * beyond looks: with everyone stacked on one tile every client sits inside every other
   * client's view radius, so interest management filters nothing and a load test measures the
   * worst case only.
   *
   * The area is a parameter rather than `this.spawn` so that a portal arrival and a plain join
   * share this one placement path; both centres are boot-validated as walkable.
   *
   * Rejection sampling rather than a precomputed list of walkable tiles — 74% of grand-plaza's
   * spawn square is walkable, so a draw succeeds in ~1.3 attempts and 16 consecutive misses has
   * probability ~5e-10. The fallback is the centre tile, which boot validates as walkable.
   */
  private pickSpawnTile(area: SpawnArea): TilePosition {
    const radius = area.spreadRadiusInTiles;
    if (radius <= 0) {
      return { tileX: area.tileX, tileY: area.tileY };
    }
    const span = radius * 2 + 1;
    for (let attempt = 0; attempt < SPAWN_SAMPLE_ATTEMPTS; attempt++) {
      // Draws outside the map need no separate guard: isWalkable() already reports them blocked.
      const tileX = area.tileX - radius + Math.floor(Math.random() * span);
      const tileY = area.tileY - radius + Math.floor(Math.random() * span);
      if (this.collisionMap.isWalkable(tileX, tileY)) {
        return { tileX, tileY };
      }
    }
    return { tileX: area.tileX, tileY: area.tileY };
  }

  /**
   * Applies one player's position change (join, step or leave) to just the StateViews it can
   * possibly affect.
   *
   * Only that one player moved, so the only thing that can change for anybody else is whether
   * this player is visible to them — they were visible if the observer was within radius of
   * `from`, and they are visible if the observer is within radius of `to`. An observer outside
   * both radii has no way to be affected and is never visited at all. That is why the cost
   * scales with the local neighbourhood rather than with the room population.
   *
   * The mover is the exception: their own origin moved, so their view is recomputed whole by
   * {@link refreshViewFor}.
   *
   * `from` null means a join, `to` null means a leave. By the time this is called `state.players`
   * and the proximity index must already reflect `to`. A leave reads neither of them for the
   * departing player — `from` is passed in and the loop skips the leaver — so on that path the
   * deletions may equally well have happened already.
   */
  private refreshViewsAround(
    sessionId: string,
    from: TilePosition | null,
    to: TilePosition | null,
  ): void {
    const anchor = to ?? from;
    if (anchor === null) {
      return;
    }
    const subject = to === null ? null : this.state.players.get(sessionId);
    const step = from !== null && to !== null ? chebyshevDistance(from, to) : 0;

    // One query instead of `within(from) ∪ within(to)`: everything within radius of `from`
    // is within radius + step of `to`, so this is a superset of both and needs no dedup.
    const neighbours = this.proximityIndex.within(
      anchor,
      VIEW_RADIUS_TILES + step,
      this.neighbourBuffer,
    );

    for (const viewerId of neighbours) {
      if (viewerId === sessionId) {
        continue;
      }
      const viewer = this.state.players.get(viewerId);
      const view = this.clientsBySession.get(viewerId)?.view;
      const viewed = this.viewedBySession.get(viewerId);
      if (!viewer || !view || !viewed) {
        continue;
      }

      const wasVisible = from !== null && chebyshevDistance(viewer, from) <= VIEW_RADIUS_TILES;
      const isVisible = to !== null && chebyshevDistance(viewer, to) <= VIEW_RADIUS_TILES;
      if (wasVisible === isVisible) {
        continue;
      }

      if (isVisible) {
        if (subject && !viewed.has(sessionId)) {
          view.add(subject);
          viewed.add(sessionId);
        }
      } else {
        // A null subject means a leave: the `state.players` deletion that follows carries the
        // removal into every view by itself, so only the bookkeeping is dropped here.
        if (subject) {
          view.remove(subject);
        }
        viewed.delete(sessionId);
      }
    }

    // Strictly after the loop above, never interleaved with it: this reads `neighbourBuffer`'s
    // sibling buffer, and the two would collide if a query ran while the other was being read.
    if (to !== null) {
      this.refreshViewFor(sessionId);
    }
  }

  /**
   * Recomputes one client's StateView from scratch — O(k) query plus an O(k) diff. Used for the
   * mover itself, whose whole neighbourhood shifts, and as the audit test's ground truth.
   */
  private refreshViewFor(sessionId: string): void {
    const viewer = this.state.players.get(sessionId);
    const view = this.clientsBySession.get(sessionId)?.view;
    const viewed = this.viewedBySession.get(sessionId);
    if (!viewer || !view || !viewed) {
      return;
    }

    const inRange = this.inRange;
    inRange.clear();
    for (const id of this.proximityIndex.within(viewer, VIEW_RADIUS_TILES, this.viewQueryBuffer)) {
      inRange.add(id);
    }

    for (const id of inRange) {
      if (viewed.has(id)) {
        continue;
      }
      const player = this.state.players.get(id);
      if (player) {
        view.add(player);
        viewed.add(id);
      }
    }

    for (const id of viewed) {
      if (inRange.has(id)) {
        continue;
      }
      // A player who left the room is already gone from `state.players`; the map
      // deletion carries that to the client, so only the bookkeeping is dropped.
      const player = this.state.players.get(id);
      if (player) {
        view.remove(player);
      }
      viewed.delete(id);
    }
  }

  /**
   * Builds this room's monsters, or does nothing at all when the table names no monster here.
   *
   * "Nothing at all" is the contract, not an optimisation: no second index is constructed, no
   * simulation loop is started, and no monster code runs on any later path. The rooms this
   * feature must not slow down are the ones PoC #2 measured.
   */
  private populateMonsters(): void {
    const spawns = this.monsterSpawns();
    if (spawns.length === 0) {
      return;
    }
    const types = this.monsterTypes();
    this.monsterIndex = this.createMonsterIndex(this.collisionMap);

    for (const definition of spawns) {
      const type = types.get(definition.kind);
      if (type === undefined) {
        // Boot validation refuses an unknown kind, so this is unreachable in production. A
        // fixture that skips that validation loses the row rather than the whole room.
        continue;
      }
      const runtime: MonsterRuntime = {
        definition,
        type,
        state: MonsterAiState.Idle,
        nextStepAt: 0,
        nextAttackAt: 0,
        respawnAt: 0,
      };
      this.monsterRuntimes.set(definition.id, runtime);
      this.spawnMonster(definition.id, runtime);
    }
    this.hasMonsters = this.state.monsters.size > 0;
  }

  /**
   * Puts a monster on its spawn tile — the first placement at `onCreate` and every respawn after
   * it take this one path, which is the point: a respawn is a join, and it has to reach the
   * clients' views the same way a join does.
   *
   * The view refresh finds nobody at `onCreate`, since the room has no clients yet.
   */
  private spawnMonster(monsterId: string, runtime: MonsterRuntime): void {
    const { at, kind } = runtime.definition;
    this.state.monsters.set(
      monsterId,
      new Monster({ kind, tileX: at.tileX, tileY: at.tileY, facing: Direction.Down }),
    );
    // Index before view, as everywhere else in this room.
    this.monsterIndex.insert(monsterId, at);
    this.refreshMonsterViewAround(monsterId, null, at);
    runtime.state = MonsterAiState.Idle;
  }

  /**
   * Takes a monster off the map and starts its respawn timer. Death is a deletion rather than a
   * flag so that it travels the leave path a player already travels; a `dead: boolean` would
   * invent a third condition ("visible but not interactable") for both sides to handle.
   *
   * No combat exists yet to call this — Pass E's damage handling is what will. It is written and
   * reachable now so that the view bookkeeping of a death and a respawn can be tested before the
   * thing that triggers them exists.
   */
  private killMonster(monsterId: string, now: number): void {
    const runtime = this.monsterRuntimes.get(monsterId);
    const monster = this.state.monsters.get(monsterId);
    if (!runtime || !monster) {
      return;
    }
    const from = { tileX: monster.tileX, tileY: monster.tileY };
    this.monsterIndex.remove(monsterId);
    this.refreshMonsterViewAround(monsterId, from, null);
    // After the bookkeeping above, exactly as in `onLeave`: this deletion is what carries the
    // removal into every StateView, so `refreshMonsterViewAround` only has to drop the ledger.
    this.state.monsters.delete(monsterId);
    runtime.state = MonsterAiState.Dead;
    runtime.respawnAt = now + runtime.type.respawnDelayMs;
  }

  /**
   * One simulation step for every monster in the room.
   *
   * `now` is a parameter and is never re-read from the clock inside: every decision in one tick
   * has to see one timestamp or the same inputs stop producing the same tick. It is also what
   * lets the tests drive the loop directly instead of waiting on a timer.
   *
   * Iterates the runtimes rather than `state.monsters` because a dead monster has no state entry
   * and still has a respawn to count down.
   */
  private tick(now: number): void {
    for (const [monsterId, runtime] of this.monsterRuntimes) {
      const monster = this.state.monsters.get(monsterId);
      const { at } = runtime.definition;
      const snapshot: MonsterSnapshot = {
        id: monsterId,
        state: runtime.state,
        tileX: monster?.tileX ?? at.tileX,
        tileY: monster?.tileY ?? at.tileY,
        spawn: at,
        wanderRadiusTiles: runtime.definition.wanderRadiusTiles,
        nextStepAt: runtime.nextStepAt,
        nextAttackAt: runtime.nextAttackAt,
        respawnAt: runtime.respawnAt,
      };

      const targets = this.monsterTargets;
      targets.length = 0;
      if (monster !== undefined) {
        const nearby = this.proximityIndex.within(
          monster,
          runtime.type.aggroRadiusTiles,
          this.monsterAggroBuffer,
        );
        for (const sessionId of nearby) {
          const player = this.state.players.get(sessionId);
          if (player) {
            targets.push({ sessionId, tileX: player.tileX, tileY: player.tileY });
          }
        }
      }

      const action = decideMonsterAction(snapshot, targets, now, runtime.type);
      runtime.state = action.state;

      switch (action.kind) {
        case MonsterActionKind.Step:
          runtime.nextStepAt = action.nextStepAt;
          if (monster !== undefined) {
            this.stepMonster(monsterId, monster, action.directions);
          }
          break;
        case MonsterActionKind.Attack:
          runtime.nextAttackAt = action.nextAttackAt;
          if (monster !== undefined && action.facing !== null) {
            monster.facing = action.facing;
          }
          // Nothing else happens here yet. Damage, the hit fan-out and the player's own health
          // are Pass E's; this pass computes the transition into `attack` and stops there.
          break;
        case MonsterActionKind.Respawn:
          this.spawnMonster(monsterId, runtime);
          break;
        case MonsterActionKind.Hold:
          break;
      }
    }
  }

  /**
   * Applies the first of `directions` the collision map allows, using the same resolver the
   * players walk with — a monster and a player obey one set of collision rules, and duplicating
   * a verified 39-line function to say so twice would be the wrong kind of saving.
   *
   * A monster that finds every candidate blocked still turns, for the reason a player does: the
   * turn is information even when the position does not change.
   */
  private stepMonster(
    monsterId: string,
    monster: Monster,
    directions: readonly Direction[],
  ): void {
    const from = { tileX: monster.tileX, tileY: monster.tileY };
    for (const direction of directions) {
      const destination = this.movementResolver.resolveStep(from, direction, this.collisionMap);
      if (destination === null) {
        continue;
      }
      monster.facing = direction;
      monster.tileX = destination.tileX;
      monster.tileY = destination.tileY;
      // Index strictly first. Reverse these and the monster is left permanently visible, or
      // permanently invisible, to whoever was on the boundary — quietly, and only for them.
      this.monsterIndex.move(monsterId, destination);
      this.refreshMonsterViewAround(monsterId, from, destination);
      return;
    }
    const [blocked] = directions;
    if (blocked !== undefined) {
      monster.facing = blocked;
    }
  }

  /**
   * Recomputes one client's monster view from scratch. {@link refreshViewFor}'s mirror image, and
   * called from the same three places: after a join, after an accepted step, and after a warp.
   *
   * Never reached in a room without monsters — every caller is behind the `hasMonsters` guard.
   */
  private refreshMonsterViewFor(sessionId: string): void {
    const viewer = this.state.players.get(sessionId);
    const view = this.clientsBySession.get(sessionId)?.view;
    const viewed = this.monstersViewedBySession.get(sessionId);
    if (!viewer || !view || !viewed) {
      return;
    }

    const inRange = this.monstersInRange;
    inRange.clear();
    for (const id of this.monsterIndex.within(viewer, VIEW_RADIUS_TILES, this.monsterQueryBuffer)) {
      inRange.add(id);
    }

    for (const id of inRange) {
      if (viewed.has(id)) {
        continue;
      }
      const monster = this.state.monsters.get(id);
      if (monster) {
        view.add(monster);
        viewed.add(id);
      }
    }

    for (const id of viewed) {
      if (inRange.has(id)) {
        continue;
      }
      // A monster that has died is already out of `state.monsters`; that deletion carries the
      // removal to the client, so only the ledger entry is dropped here.
      const monster = this.state.monsters.get(id);
      if (monster) {
        view.remove(monster);
      }
      viewed.delete(id);
    }
  }

  /**
   * Applies one monster's position change to just the views it can possibly affect —
   * {@link refreshViewsAround} for monsters, with the same argument convention: `from` null is a
   * spawn, `to` null is a death, and `state.monsters` and `monsterIndex` must already agree with
   * `to` by the time this is called.
   *
   * Shorter than its player twin by exactly one thing: a monster has no StateView of its own, so
   * there is no subject view to rebuild at the end.
   */
  private refreshMonsterViewAround(
    monsterId: string,
    from: TilePosition | null,
    to: TilePosition | null,
  ): void {
    const anchor = to ?? from;
    if (anchor === null) {
      return;
    }
    const subject = to === null ? null : this.state.monsters.get(monsterId);
    const step = from !== null && to !== null ? chebyshevDistance(from, to) : 0;

    // One query rather than `within(from) ∪ within(to)`, for the reason the player path gives:
    // radius + step around `to` is a superset of both and needs no deduplication.
    const viewers = this.proximityIndex.within(
      anchor,
      VIEW_RADIUS_TILES + step,
      this.monsterNeighbourBuffer,
    );

    for (const viewerId of viewers) {
      const viewer = this.state.players.get(viewerId);
      const view = this.clientsBySession.get(viewerId)?.view;
      const viewed = this.monstersViewedBySession.get(viewerId);
      if (!viewer || !view || !viewed) {
        continue;
      }

      const wasVisible = from !== null && chebyshevDistance(viewer, from) <= VIEW_RADIUS_TILES;
      const isVisible = to !== null && chebyshevDistance(viewer, to) <= VIEW_RADIUS_TILES;
      if (wasVisible === isVisible) {
        continue;
      }

      if (isVisible) {
        if (subject && !viewed.has(monsterId)) {
          view.add(subject);
          viewed.add(monsterId);
        }
      } else {
        // A null subject is a death: the `state.monsters` deletion that follows carries the
        // removal into every view by itself, so only the ledger is dropped here.
        if (subject) {
          view.remove(subject);
        }
        viewed.delete(monsterId);
      }
    }
  }
}

/**
 * The wire form of an object row, built field by field rather than by spreading the row. A spread
 * would carry `answerIndex` onto the wire, and a quiz whose answer is in the network tab has given
 * away the only thing it had; it would also ship the authoring coordinates, which the client
 * already has from the markers.
 */
function toInteraction(object: InteractableDefinition): InteractableEntered {
  switch (object.kind) {
    case InteractableKind.Link:
      return { kind: object.kind, objectId: object.id, title: object.title, url: object.url };
    case InteractableKind.Notice:
      return { kind: object.kind, objectId: object.id, title: object.title, body: object.body };
    case InteractableKind.Quiz:
      return {
        kind: object.kind,
        objectId: object.id,
        title: object.title,
        question: object.question,
        choices: object.choices,
      };
  }
}

function normalizeNickname(nickname: unknown): string | null {
  if (typeof nickname !== "string") {
    return null;
  }
  const trimmed = nickname.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Sliced by code point: a UTF-16 cut can land inside a surrogate pair, and the lone
  // surrogate desyncs the schema string encoder's length prefix from what it writes,
  // corrupting the whole Player entry for every other client.
  return [...trimmed].slice(0, MAX_NICKNAME_LENGTH).join("");
}

/** A bad skin index is cosmetic, so it falls back to 0 instead of refusing the join. */
function normalizeAvatarSkin(avatarSkin: unknown): number {
  if (typeof avatarSkin !== "number" || !Number.isInteger(avatarSkin)) {
    return 0;
  }
  return avatarSkin >= 0 && avatarSkin < AVATAR_SKIN_COUNT ? avatarSkin : 0;
}
