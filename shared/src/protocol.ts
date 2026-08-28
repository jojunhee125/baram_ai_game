import type { Direction } from "./geometry";

/** Options sent with joinOrCreate(). Validated server-side before the player is spawned. */
export interface JoinOptions {
  nickname: string;
  avatarSkin: number;
  /**
   * Id of the portal the player walked into, echoed back from {@link PortalEntered}. Only the
   * id travels: the destination room resolves it to an arrival tile from its own copy of the
   * portal table, so the client never asserts coordinates.
   *
   * An id this room does not own falls back to the room's generic spawn instead of refusing
   * the join — a refusal would strand a client whose portal row changed under it.
   */
  viaPortal?: string;
  /**
   * Place the player on this room's home tile — its spawn centre, with the spawn's spread
   * deliberately dropped — instead of sampling the spawn area. Set by the "return home" control
   * when home is a different room, so that the cross-room path lands on exactly the tile the
   * same-room warp would have chosen.
   *
   * No coordinates travel: the client names a room it could already join, and the destination
   * room resolves the tile from its own config. `viaPortal` wins if both are somehow present —
   * it is the more specific request and the only one of the two the server itself issued.
   */
  arriveAtHome?: boolean;
}

export const ClientMessage = {
  Move: "move",
  Chat: "chat",
  ReturnHome: "home:return",
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
  /**
   * No payload: the destination is this room's own home tile, so there is nothing for the client
   * to say and nothing for the server to parse. Rate-limited by HOME_COOLDOWN_MS; a request
   * inside that window is dropped silently, since the client mirrors the same window and a
   * player who gets there anyway is already standing on the tile they asked for.
   */
  [ClientMessage.ReturnHome]: undefined;
}

export const ServerMessage = {
  Chat: "chat",
  MoveRejected: "move:rejected",
  PortalEntered: "portal:entered",
  Teleported: "player:teleported",
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

/**
 * The player's accepted step landed on a portal trigger tile; the client is expected to
 * transition to `toRoom` and rejoin with `JoinOptions.viaPortal = portalId`.
 *
 * Carries the destination room name rather than leaving the client to resolve `portalId`:
 * the server serves the client bundle itself, so a browser can hold a bundle older than the
 * portal table, and this way that client still ends up where the server says.
 *
 * Sent only for a move the server accepted, never for a predicted one, and only on the move
 * that enters the tile — standing on it does not re-fire. Repeat entries are possible
 * (step off, step back on), so the client must ignore this while a transition is in flight.
 */
export interface PortalEntered {
  portalId: string;
  /** Matchmaking room name to join, i.e. the `name` of a registered room. */
  toRoom: string;
}

/**
 * The server moved the player without them walking there — today only the home warp.
 *
 * Needed even though the state patch carries the same position: while steps are in flight
 * `LocalPlayer.applyServerState` consumes its own patches instead of applying them, and a warp
 * cancelled out by the steps around it produces no net state change to patch at all, so a warp
 * that lands during a walk can go unseen and leave the client behind the server. Absolute
 * position, like {@link MoveRejected}.
 *
 * Unicast to the teleporting client. Everyone else sees this as a plain position change, which
 * is why "do not tween a jump" belongs in the sprite layer and not in this message's handler.
 */
export interface Teleported {
  tileX: number;
  tileY: number;
  facing: Direction;
}

export interface ServerMessagePayload {
  [ServerMessage.Chat]: ChatBroadcast;
  [ServerMessage.MoveRejected]: MoveRejected;
  [ServerMessage.PortalEntered]: PortalEntered;
  [ServerMessage.Teleported]: Teleported;
}
