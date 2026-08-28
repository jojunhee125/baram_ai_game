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
  QuizAnswer: "quiz:answer",
} as const;

export type ClientMessage = (typeof ClientMessage)[keyof typeof ClientMessage];

/** One tile step. The server resolves the destination; the client never sends coordinates. */
export interface MoveRequest {
  dir: Direction;
}

export interface ChatRequest {
  text: string;
}

/**
 * One answer to a quiz object. The object is named rather than inferred from the player's tile:
 * the room keeps no interaction state, and the room-narrowed object index is already the boundary
 * that stops an id from another room resolving. Nothing is scored or stored anywhere, so a
 * replayed or fabricated answer wins nothing — which is why there is no position check.
 */
export interface QuizAnswerRequest {
  objectId: string;
  /** Index into {@link QuizInteraction.choices}. Out of range grades as wrong, not as an error. */
  choiceIndex: number;
}

export interface ClientMessagePayload {
  [ClientMessage.Move]: MoveRequest;
  [ClientMessage.Chat]: ChatRequest;
  [ClientMessage.QuizAnswer]: QuizAnswerRequest;
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
  InteractableEntered: "interactable:entered",
  QuizResult: "quiz:result",
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

/**
 * The fixed interactive object types of roadmap item 3 — the closed set a map author places, as
 * opposed to a scripting surface. Strings rather than numeric codes because the same value is the
 * discriminant of the server's authored table, of the wire union below, and of
 * `InteractableMarker.kind`: one readable value in all three beats a code plus the mapping table
 * that drifts away from it.
 *
 * Portals are not in this set even though the roadmap counts them as the same feature. They fire
 * the same way but they move you rather than show you something, and they already have their own
 * table (`PortalDefinition`) that predates this one.
 */
export const InteractableKind = {
  Link: "link",
  Notice: "notice",
  Quiz: "quiz",
} as const;

export type InteractableKind = (typeof InteractableKind)[keyof typeof InteractableKind];

/** What every {@link InteractableEntered} variant carries. */
interface InteractionBase {
  /**
   * The object's stable id. It comes back in {@link QuizAnswerRequest}, and it lets the client
   * drop a reply belonging to a panel it has already closed.
   */
  objectId: string;
  /** Panel heading, shown as written. */
  title: string;
}

export interface LinkInteraction extends InteractionBase {
  kind: typeof InteractableKind.Link;
  /**
   * Absolute http(s) URL, opened in a new tab and never in place. Boot validation is the only
   * check on it: the table is authored in the repo, so the table *is* the allowlist, and a
   * second check on the client would only defend against a server that is already ours. That
   * argument expires the day content becomes runtime-editable — `docs/design-fixed-objects.md` §2.
   */
  url: string;
}

export interface NoticeInteraction extends InteractionBase {
  kind: typeof InteractableKind.Notice;
  /** Newlines are significant. Rendered as text, never as markup. */
  body: string;
}

export interface QuizInteraction extends InteractionBase {
  kind: typeof InteractableKind.Quiz;
  question: string;
  /**
   * Two or more, in display order; the index into this array is what the client answers with.
   * The correct index is deliberately absent — it stays in the server's table, because a quiz
   * whose answer is in the network tab has given away the only thing it had.
   */
  choices: readonly string[];
}

/**
 * The player's accepted step landed on a fixed object's tile; the client opens the matching panel.
 *
 * Same division of labour as {@link PortalEntered} — the server detects on the authoritative
 * position, the client performs — except that the *content* travels rather than a destination.
 * That is what keeps the object table off the client entirely, so a browser holding a bundle
 * older than the table still renders whatever the server describes.
 *
 * Unicast to the walker. Fires only on the move that enters the tile, so standing on it does not
 * re-fire; stepping off and back on does.
 */
export type InteractableEntered = LinkInteraction | NoticeInteraction | QuizInteraction;

/**
 * The verdict on one {@link QuizAnswerRequest}.
 *
 * Echoes what was graded rather than only the verdict: the reply is asynchronous, so a result for
 * a panel that has since closed — or for a choice the player has since changed — has to be
 * discardable rather than land on the wrong row. Same reasoning as {@link MoveRejected} carrying
 * an absolute position instead of a delta.
 */
export interface QuizResult {
  objectId: string;
  choiceIndex: number;
  correct: boolean;
  /** The author's note, shown beside the verdict; absent when the row has none. */
  explanation?: string;
}

export interface ServerMessagePayload {
  [ServerMessage.Chat]: ChatBroadcast;
  [ServerMessage.MoveRejected]: MoveRejected;
  [ServerMessage.PortalEntered]: PortalEntered;
  [ServerMessage.Teleported]: Teleported;
  [ServerMessage.InteractableEntered]: InteractableEntered;
  [ServerMessage.QuizResult]: QuizResult;
}
