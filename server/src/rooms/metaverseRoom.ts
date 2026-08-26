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
import { NaiveProximityIndex } from "../game/proximity";
import { TiledMapLoader } from "../game/tiledMap";
import type {
  AuthResult,
  CollisionMap,
  MetaverseRoomOptions,
  RoomCreateOptions,
} from "./contracts";
import { deriveSsoNickname } from "./ssoIdentity";

type RoomClient = MetaverseRoomOptions["client"];

const MIN_MOVE_INTERVAL_MS = 1000 / MAX_MOVES_PER_SECOND;
const MIN_CHAT_INTERVAL_MS = 1000 / MAX_CHATS_PER_SECOND;

/** Colyseus disconnects past this. Legitimate play peaks at 22 msg/s; the rest is burst headroom. */
const MAX_MESSAGES_PER_SECOND = 60;

export class MetaverseRoom extends Room<MetaverseRoomOptions> {
  private readonly mapLoader = new TiledMapLoader();
  private readonly movementResolver = new TileMovementResolver();
  /** Session ids currently added to each client's StateView, keyed by viewer session id. */
  private readonly viewedBySession = new Map<string, Set<string>>();
  /** Sessions already told about the current throttled burst, so one burst yields one notice. */
  private readonly moveThrottleNotified = new Set<string>();
  private collisionMap!: CollisionMap;
  private proximityIndex!: NaiveProximityIndex;
  private spawn!: TilePosition;

  async onCreate(options: RoomCreateOptions): Promise<void> {
    this.state = new RoomState();
    this.state.roomType = options.roomType;
    this.state.mapKey = options.mapKey;
    this.maxClients = options.maxClients;
    this.spawn = options.spawn;
    this.setPatchRate(PATCH_RATE_MS);
    this.maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

    this.collisionMap = await this.mapLoader.load(options.mapKey);
    this.proximityIndex = new NaiveProximityIndex(this.state.players);

    this.onMessage(ClientMessage.Move, (client: RoomClient, message: MoveRequest) => {
      this.handleMove(client, message);
    });
    this.onMessage(ClientMessage.Chat, (client: RoomClient, message: ChatRequest) => {
      this.handleChat(client, message);
    });
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

    this.state.players.set(
      client.sessionId,
      new Player({
        nickname,
        tileX: this.spawn.tileX,
        tileY: this.spawn.tileY,
        facing: Direction.Down,
        avatarSkin: normalizeAvatarSkin(options?.avatarSkin),
      }),
    );
    client.userData = { nickname, lastMoveAt: 0, lastChatAt: 0 };
    client.view = new StateView();
    this.viewedBySession.set(client.sessionId, new Set());

    this.refreshViews();
  }

  onLeave(client: RoomClient): void {
    this.state.players.delete(client.sessionId);
    this.viewedBySession.delete(client.sessionId);
    this.moveThrottleNotified.delete(client.sessionId);
    this.refreshViews();
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

    player.tileX = destination.tileX;
    player.tileY = destination.tileY;
    this.refreshViews();
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
    const audience = this.proximityIndex.within(
      { tileX: player.tileX, tileY: player.tileY },
      CHAT_RADIUS_TILES,
    );
    for (const sessionId of audience) {
      this.clients.getById(sessionId)?.send(ServerMessage.Chat, broadcast);
    }
  }

  private refreshViews(): void {
    for (const client of this.clients) {
      const view = client.view;
      const viewer = this.state.players.get(client.sessionId);
      const viewed = this.viewedBySession.get(client.sessionId);
      if (!view || !viewer || !viewed) {
        continue;
      }

      const inRange = new Set(
        this.proximityIndex.within(
          { tileX: viewer.tileX, tileY: viewer.tileY },
          VIEW_RADIUS_TILES,
        ),
      );

      for (const sessionId of inRange) {
        if (viewed.has(sessionId)) {
          continue;
        }
        const player = this.state.players.get(sessionId);
        if (player) {
          view.add(player);
          viewed.add(sessionId);
        }
      }

      for (const sessionId of viewed) {
        if (inRange.has(sessionId)) {
          continue;
        }
        // A player who left the room is already gone from `state.players`; the map
        // deletion carries that to the client, so only the bookkeeping is dropped.
        const player = this.state.players.get(sessionId);
        if (player) {
          view.remove(player);
        }
        viewed.delete(sessionId);
      }
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
