import type { Direction } from "./geometry";

/** Options sent with joinOrCreate(). Validated server-side before the player is spawned. */
export interface JoinOptions {
  nickname: string;
  avatarSkin: number;
}

export const ClientMessage = {
  Move: "move",
  Chat: "chat",
} as const;

export type ClientMessage = (typeof ClientMessage)[keyof typeof ClientMessage];

/** One tile step. The server resolves the destination; the client never sends coordinates. */
export interface MoveRequest {
  dir: Direction;
}

export interface ChatRequest {
  text: string;
}

export interface ClientMessagePayload {
  [ClientMessage.Move]: MoveRequest;
  [ClientMessage.Chat]: ChatRequest;
}

export const ServerMessage = {
  Chat: "chat",
  MoveRejected: "move:rejected",
} as const;

export type ServerMessage = (typeof ServerMessage)[keyof typeof ServerMessage];

export interface ChatBroadcast {
  sessionId: string;
  nickname: string;
  text: string;
  /** Server wall clock, ms since epoch. */
  at: number;
}

/**
 * Sent when a move is not applied (collision or rate limit). An unapplied move produces
 * no state patch, so this is the client's only signal to snap back.
 */
export interface MoveRejected {
  tileX: number;
  tileY: number;
  facing: Direction;
}

export interface ServerMessagePayload {
  [ServerMessage.Chat]: ChatBroadcast;
  [ServerMessage.MoveRejected]: MoveRejected;
}
