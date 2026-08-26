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

/** A terminal lifecycle event that arrived before `attach()` had somewhere to deliver it. */
type PendingLifecycle =
  | { kind: "leave"; code: number; reason?: string }
  | { kind: "error"; code: number; message?: string };

/**
 * Owns the Colyseus room and mirrors `state.players` into plain snapshots.
 * Rendering (C4), input (C5) and chat UI (C6) consume this; it draws nothing itself.
 */
export class RoomConnection {
  private readonly snapshots = new Map<string, PlayerSnapshot>();
  private readonly detachers = new Map<string, () => void>();
  private events: RoomEvents = {};
  private attached = false;
  private pendingLifecycle: PendingLifecycle | null = null;

  private constructor(
    private readonly room: Room<unknown, RoomState>,
    /** Read from RoomState, so the client can never disagree with the server about the map. */
    readonly mapKey: string,
  ) {
    this.bindLifecycle();
  }

  /**
   * Joins `roomName` and resolves only once the first state has arrived, so `mapKey` and
   * `players` are populated: `joinOrCreate` alone resolves on the JOIN_ROOM frame, which
   * precedes ROOM_STATE by an ack round trip.
   */
  static async connect(roomName: string, options?: JoinOptions): Promise<RoomConnection> {
    const client = new Client(resolveEndpoint());
    const room = await client.joinOrCreate<RoomState>(
      roomName,
      options ?? createPlaceholderIdentity(),
      RoomState,
    );
    await firstState(room);
    return new RoomConnection(room, room.state.mapKey);
  }

  /** Wires renderers. `onPlayerAdd` fires at once for everyone already in view. */
  attach(events: RoomEvents): void {
    this.events = events;
    this.attached = true;
    this.bindPlayers();
    this.bindMessages();
    this.replayPendingLifecycle();
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
  }

  /**
   * A drop between `connect()` and `attach()` (the whole map-loading window) would otherwise
   * vanish into the empty `this.events`, leaving a world that renders and predicts movement
   * against a socket the server never sees. One slot is enough: a room terminates once.
   */
  private bindLifecycle(): void {
    this.room.onLeave((code, reason) => {
      if (!this.attached) {
        this.pendingLifecycle ??= { kind: "leave", code, reason };
        return;
      }
      this.events.onLeave?.(code, reason);
    });
    this.room.onError((code, message) => {
      if (!this.attached) {
        this.pendingLifecycle ??= { kind: "error", code, message };
        return;
      }
      this.events.onError?.(code, message);
    });
  }

  /**
   * Deferred, never inline: `WorldScene.create()` calls `hideBootStatus()` immediately after
   * `attach()`, so a synchronous replay would raise the error overlay only for that call to
   * hide it again. A microtask runs after `create()` returns, so the overlay survives.
   */
  private replayPendingLifecycle(): void {
    const pending = this.pendingLifecycle;
    if (!pending) {
      return;
    }
    this.pendingLifecycle = null;
    queueMicrotask(() => {
      if (pending.kind === "leave") {
        this.events.onLeave?.(pending.code, pending.reason);
      } else {
        this.events.onError?.(pending.code, pending.message);
      }
    });
  }
}

/**
 * Races the three signals that can follow JOIN_ROOM: waiting on `onStateChange` alone leaves
 * the boot overlay stuck on "접속하는 중" if the socket dies before ROOM_STATE arrives.
 */
function firstState(room: Room<unknown, RoomState>): Promise<void> {
  return new Promise((resolve, reject) => {
    room.onStateChange.once(() => resolve());
    room.onError.once((code, message) =>
      reject(new Error(`room error ${code}: ${message ?? "unknown"}`)),
    );
    room.onLeave.once((code) => reject(new Error(`left before the first state (code ${code})`)));
  });
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
