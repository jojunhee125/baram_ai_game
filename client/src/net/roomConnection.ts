import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";
import {
  AVATAR_SKIN_COUNT,
  ClientMessage,
  RoomState,
  ServerMessage,
  type ChatBroadcast,
  type ChatRequest,
  type Direction,
  type JoinOptions,
  type MoveRejected,
  type MoveRequest,
  type Player,
} from "@zep-test/shared";

const ROOM_NAME = "plaza";

/** Only used by `vite dev`, where the page (:5173) and the game server are separate origins. */
const DEV_SERVER_PORT = 2567;

/**
 * In production the game server serves this bundle itself, so the socket must stay same-origin:
 * the KAD gateway authenticates and forwards exactly one domain, and a cross-origin `ws://host:2567`
 * would bypass it (and be blocked outright over https).
 */
function resolveEndpoint(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return import.meta.env.DEV
    ? `${protocol}//${window.location.hostname}:${DEV_SERVER_PORT}`
    : `${protocol}//${window.location.host}`;
}

/** Plain mirror of the synced `Player` schema, so renderers never hold schema instances. */
export interface PlayerSnapshot {
  nickname: string;
  tileX: number;
  tileY: number;
  facing: Direction;
  avatarSkin: number;
}

export interface RoomEvents {
  onPlayerAdd?(sessionId: string, player: PlayerSnapshot): void;
  onPlayerChange?(sessionId: string, player: PlayerSnapshot): void;
  onPlayerRemove?(sessionId: string): void;
  onChat?(message: ChatBroadcast): void;
  onMoveRejected?(correction: MoveRejected): void;
  /** Connection closed after a successful join — includes kick, server restart, network drop. */
  onLeave?(code: number, reason?: string): void;
  onError?(code: number, message?: string): void;
}

/**
 * Owns the Colyseus room and mirrors `state.players` into plain snapshots.
 * Rendering (C4), input (C5) and chat UI (C6) consume this; it draws nothing itself.
 */
export class RoomConnection {
  private readonly snapshots = new Map<string, PlayerSnapshot>();
  private readonly detachers = new Map<string, () => void>();

  private constructor(
    private readonly room: Room<unknown, RoomState>,
    private readonly events: RoomEvents,
  ) {
    this.bindPlayers();
    this.bindMessages();
  }

  static async connect(events: RoomEvents = {}, options?: JoinOptions): Promise<RoomConnection> {
    const client = new Client(resolveEndpoint());
    const room = await client.joinOrCreate<RoomState>(
      ROOM_NAME,
      options ?? createPlaceholderIdentity(),
      RoomState,
    );
    return new RoomConnection(room, events);
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  /** Every player currently inside this client's view radius, including itself. */
  get players(): ReadonlyMap<string, PlayerSnapshot> {
    return this.snapshots;
  }

  sendMove(dir: Direction): void {
    this.room.send(ClientMessage.Move, { dir } satisfies MoveRequest);
  }

  sendChat(text: string): void {
    this.room.send(ClientMessage.Chat, { text } satisfies ChatRequest);
  }

  async leave(): Promise<void> {
    await this.room.leave(true);
  }

  private bindPlayers(): void {
    const $ = getStateCallbacks(this.room);

    $(this.room.state).players.onAdd((player: Player, sessionId: string) => {
      this.snapshots.set(sessionId, toSnapshot(player));
      this.events.onPlayerAdd?.(sessionId, toSnapshot(player));

      // Collection onChange is not recursive, so per-player listeners attach here.
      this.detachers.set(
        sessionId,
        $(player).onChange(() => {
          const snapshot = toSnapshot(player);
          this.snapshots.set(sessionId, snapshot);
          this.events.onPlayerChange?.(sessionId, snapshot);
        }),
      );
    });

    $(this.room.state).players.onRemove((_player: Player, sessionId: string) => {
      this.detachers.get(sessionId)?.();
      this.detachers.delete(sessionId);
      this.snapshots.delete(sessionId);
      this.events.onPlayerRemove?.(sessionId);
    });
  }

  private bindMessages(): void {
    this.room.onMessage(ServerMessage.Chat, (message: ChatBroadcast) => {
      this.events.onChat?.(message);
    });
    this.room.onMessage(ServerMessage.MoveRejected, (correction: MoveRejected) => {
      this.events.onMoveRejected?.(correction);
    });
    this.room.onLeave((code, reason) => {
      this.events.onLeave?.(code, reason);
    });
    this.room.onError((code, message) => {
      this.events.onError?.(code, message);
    });
  }
}

function toSnapshot(player: Player): PlayerSnapshot {
  return {
    nickname: player.nickname,
    tileX: player.tileX,
    tileY: player.tileY,
    // `facing` crosses the wire as uint8; the server only ever writes Direction values.
    facing: player.facing as Direction,
    avatarSkin: player.avatarSkin,
  };
}

/** Stand-in until a character-select screen exists; not a Phase1 deliverable. */
function createPlaceholderIdentity(): JoinOptions {
  return {
    nickname: `손님${Math.floor(Math.random() * 9000) + 1000}`,
    avatarSkin: Math.floor(Math.random() * AVATAR_SKIN_COUNT),
  };
}
