import { StateView } from "@colyseus/schema";
import { Room, type AuthContext } from "colyseus";
import {
  AVATAR_SKIN_COUNT,
  CHAT_RADIUS_TILES,
  ClientMessage,
  Direction,
  MAX_CHAT_LENGTH,
  MAX_CHATS_PER_SECOND,
  MAX_MOVES_PER_SECOND,
  MAX_NICKNAME_LENGTH,
  PATCH_RATE_MS,
  Player,
  RoomState,
  ServerMessage,
  VIEW_RADIUS_TILES,
  type ChatBroadcast,
  type ChatRequest,
  type JoinOptions,
  type MoveRejected,
  type MoveRequest,
  type TilePosition,
} from "@zep-test/shared";
import { isDirection, TileMovementResolver } from "../game/movement";
import { chebyshevDistance, UniformGridProximityIndex } from "../game/proximity";
import { TiledMapLoader } from "../game/tiledMap";
import type {
  AuthResult,
  CollisionMap,
  MetaverseRoomOptions,
  ProximityIndex,
  RoomCreateOptions,
  SpawnArea,
} from "./contracts";
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
 */
const PROXIMITY_CELL_SIZE_TILES = VIEW_RADIUS_TILES + 1;

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
  private collisionMap!: CollisionMap;
  private proximityIndex!: ProximityIndex;
  private spawn!: SpawnArea;

  async onCreate(options: RoomCreateOptions): Promise<void> {
    this.state = new RoomState();
    this.state.roomType = options.roomType;
    this.state.mapKey = options.mapKey;
    this.maxClients = options.maxClients;
    this.spawn = options.spawn;
    this.setPatchRate(PATCH_RATE_MS);
    this.maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

    this.collisionMap = await this.mapLoader.load(options.mapKey);
    this.proximityIndex = this.createProximityIndex(this.collisionMap);

    this.onMessage(ClientMessage.Move, (client: RoomClient, message: MoveRequest) => {
      this.handleMove(client, message);
    });
    this.onMessage(ClientMessage.Chat, (client: RoomClient, message: ChatRequest) => {
      this.handleChat(client, message);
    });
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

    const spawnTile = this.pickSpawnTile();
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
    client.userData = { nickname, lastMoveAt: 0, lastChatAt: 0 };
    client.view = new StateView();
    this.viewedBySession.set(client.sessionId, new Set());
    this.clientsBySession.set(client.sessionId, client);

    this.refreshViewsAround(client.sessionId, null, spawnTile);
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
   * A walkable tile within `spreadRadiusInTiles` of the room's spawn centre. Spreading matters
   * beyond looks: with everyone stacked on one tile every client sits inside every other
   * client's view radius, so interest management filters nothing and a load test measures the
   * worst case only.
   *
   * Rejection sampling rather than a precomputed list of walkable tiles — 74% of grand-plaza's
   * spawn square is walkable, so a draw succeeds in ~1.3 attempts and 16 consecutive misses has
   * probability ~5e-10. The fallback is the centre tile, which boot validates as walkable.
   */
  private pickSpawnTile(): TilePosition {
    const radius = this.spawn.spreadRadiusInTiles;
    if (radius <= 0) {
      return { tileX: this.spawn.tileX, tileY: this.spawn.tileY };
    }
    const span = radius * 2 + 1;
    for (let attempt = 0; attempt < SPAWN_SAMPLE_ATTEMPTS; attempt++) {
      // Draws outside the map need no separate guard: isWalkable() already reports them blocked.
      const tileX = this.spawn.tileX - radius + Math.floor(Math.random() * span);
      const tileY = this.spawn.tileY - radius + Math.floor(Math.random() * span);
      if (this.collisionMap.isWalkable(tileX, tileY)) {
        return { tileX, tileY };
      }
    }
    return { tileX: this.spawn.tileX, tileY: this.spawn.tileY };
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
