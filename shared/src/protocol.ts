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
  /**
   * One swing. No payload, for {@link ClientMessage.ReturnHome}'s reason — the client has nothing
   * to say. The server picks what the swing lands on from the attacker's own position and facing,
   * so there is no way to name a monster that is not there and no visibility check to invent.
   * Rate-limited by ATTACK_COOLDOWN_MS.
   */
  Attack: "combat:attack",
  EquipItem: "equipment:equip",
  UnequipItem: "equipment:unequip",
  /** Live re-skin from the in-game character menu. No ack: see ChangeSkinRequest. */
  ChangeSkin: "avatar:change-skin",
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

/** Names the item to equip. An unknown key, or one with no `equipment` stats, is ignored. */
export interface EquipItemRequest {
  itemKey: string;
}

/**
 * Range is validated against AVATAR_SKIN_COUNT server-side and dropped silently out of range —
 * the same treatment EquipItemRequest gives an unknown key. No cooldown: unlike every other
 * mutating message this touches no DB and no proximity index, so there is nothing beyond
 * Colyseus' own MAX_MESSAGES_PER_SECOND to protect.
 */
export interface ChangeSkinRequest {
  skin: number;
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
  /**
   * No payload, and no reply either when the swing hits nothing: an empty swing is the client's
   * own animation, and unlike a rejected move there is no prediction to correct. A request inside
   * ATTACK_COOLDOWN_MS is dropped in silence for the same reason.
   */
  [ClientMessage.Attack]: undefined;
  [ClientMessage.EquipItem]: EquipItemRequest;
  /** No payload: there is at most one equipped item, so there is nothing to name. */
  [ClientMessage.UnequipItem]: undefined;
  [ClientMessage.ChangeSkin]: ChangeSkinRequest;
}

export const ServerMessage = {
  Chat: "chat",
  MoveRejected: "move:rejected",
  PortalEntered: "portal:entered",
  PortalDenied: "portal:denied",
  Teleported: "player:teleported",
  InteractableEntered: "interactable:entered",
  QuizResult: "quiz:result",
  MonsterHit: "combat:monster-hit",
  PlayerHit: "combat:player-hit",
  ItemGranted: "inventory:granted",
  EquipmentChanged: "equipment:changed",
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
 * The player's accepted step landed on a portal trigger tile that requires an item they do not
 * hold. Sent instead of {@link PortalEntered}; no room transition happens and the tile stays
 * exactly as walkable as it was, so the player is left standing on it.
 */
export interface PortalDenied {
  portalId: string;
  /** The server table's deniedMessage, verbatim. */
  message: string;
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

/**
 * A monster took a hit.
 *
 * Unicast to every player within `VIEW_RADIUS_TILES` of the monster — the chat audience loop's
 * shape and its O(k) cost. The view radius rather than `CHAT_RADIUS_TILES` because a monster you
 * can see is a monster whose bar you have to be able to watch, and an event about a monster
 * outside your view is an event about an entity your client has never heard of.
 *
 * `Monster` carries no HP, so this is the only path health takes to the client.
 *
 * `hpRemaining === 0` is the death notice. There is no separate "defeated" message because it
 * would always leave in the same tick, to the same audience, as this one — two messages that
 * always travel together are one message. The client plays the death animation on it and lets the
 * `state.monsters` deletion clear the sprite.
 */
export interface MonsterHit {
  monsterId: string;
  /** Who swung, so a client can tell "I killed that" from "somebody killed that". */
  bySessionId: string;
  damage: number;
  hpRemaining: number;
  /** For scaling the bar. Sent every time, so the client never holds a monster stat table. */
  hpMax: number;
}

/**
 * You were hit. Unicast to the victim and to nobody else: no one sees anybody else's health, the
 * same judgement that kept monster HP out of the state. Onlookers get the hit animation from the
 * monster's own attack and no number.
 *
 * `hpRemaining === 0` is death. The move back to the room's home tile arrives as the existing
 * {@link Teleported}, which is already the message for "the server moved you without you
 * walking", and death costs nothing else — no items, no experience, no waiting.
 */
export interface PlayerHit {
  monsterId: string;
  damage: number;
  hpRemaining: number;
  /** PLAYER_MAX_HP today, and sent anyway for {@link MonsterHit.hpMax}'s reason. */
  hpMax: number;
}

/**
 * A drop was credited to your account.
 *
 * Sent only once the store has committed it. A wire that speaks before the store does produces
 * "I picked it up and it was gone next login", which is the worse of the two failures; the
 * opposite — stored but never announced — resolves itself the next time the bag is opened, which
 * is why a failed grant sends nothing at all.
 *
 * Skipped entirely when the killer has already left the room. The grant still happens: a bag
 * belongs to an account rather than to a room.
 */
export interface ItemGranted {
  itemKey: string;
  /**
   * Display name, sent rather than looked up, so a client older than the item table still draws
   * the row it was handed — `GET /api/inventory` hands its rows over on the same terms.
   */
  name: string;
  /** Icon key, travelling with the row for {@link ItemGranted.name}'s reason. */
  icon: string;
  /** How many arrived this time. */
  quantity: number;
  /** Total held afterwards, so an open bag window updates without a re-read. */
  total: number;
  /**
   * Fraction of incoming monster damage this item removes while equipped, present only for an
   * equipment item. Sent so the bag's toast can show the stat without the client holding a
   * catalogue of its own.
   */
  damageReductionRatio?: number;
}

/**
 * The result of one equip or unequip request. Unicast to the requester and to nobody else — the
 * same rule as {@link PlayerHit}: what somebody else has equipped is their own business.
 */
export interface EquipmentChanged {
  /** What is equipped after this request, or null if nothing is. */
  itemKey: string | null;
  /**
   * False when an equip named an item the account does not hold, or lost a same-account,
   * different-tab concurrent equip race — or when an unequip found nothing equipped. Always the
   * store's own answer, never a locally-cached guess, so the state above is unchanged only when
   * this is false.
   */
  applied: boolean;
}

export interface ServerMessagePayload {
  [ServerMessage.Chat]: ChatBroadcast;
  [ServerMessage.MoveRejected]: MoveRejected;
  [ServerMessage.PortalEntered]: PortalEntered;
  [ServerMessage.PortalDenied]: PortalDenied;
  [ServerMessage.Teleported]: Teleported;
  [ServerMessage.InteractableEntered]: InteractableEntered;
  [ServerMessage.QuizResult]: QuizResult;
  [ServerMessage.MonsterHit]: MonsterHit;
  [ServerMessage.PlayerHit]: PlayerHit;
  [ServerMessage.ItemGranted]: ItemGranted;
  [ServerMessage.EquipmentChanged]: EquipmentChanged;
}
