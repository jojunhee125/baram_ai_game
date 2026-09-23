import type { PlayerClassKey } from "./classes";
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
  /**
   * Warp to this landmark id's tile instead of sampling the spawn area — the cross-room half of
   * the landmark panel (`docs/design-phase-m-landmark-teleport.md`). Same non-assertion rule as
   * `arriveAtHome`: only an id travels, and the destination room resolves it against its own
   * table. `viaPortal` wins if both are present; this wins over `arriveAtHome` — a named landmark
   * is the more specific request. An id this room does not own falls back to `arriveAtHome`/spawn,
   * never to a refusal — the one exception is a landmark whose own row requires an item the
   * account does not hold, which refuses the join entirely (§2.4): unlike every other unowned-id
   * case here, that is not "unknown", it is "known and denied".
   */
  arriveAtLandmark?: string;
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
  /** Same-room half of the landmark panel; the cross-room half rejoins via JoinOptions.arriveAtLandmark. */
  WarpToLandmark: "landmark:warp",
  /**
   * Accepts a quest the NPC panel just offered (roadmap R03). Idempotent end to end — the store's
   * upsert returns the existing row rather than resetting a counter — so a replayed or duplicated
   * message costs a round trip and changes nothing.
   */
  AcceptQuest: "quest:accept",
  /**
   * Buys `quantity` of `itemKey` from the shop NPC named by `npcObjectId` (roadmap R04-c, design
   * `docs/r04-settlement.md` §9 D8/D10/D11). `npcObjectId` is resolved against this room's own
   * {@link InteractableIndex} the way {@link AcceptQuestRequest.questId} is resolved against the
   * giver index — the price is never trusted from the client, only looked up server-side from the
   * matching `ShopDefinition`. `nonce` is client-generated and must be resent unchanged on a retry
   * of the *same* purchase attempt (§9 D8) — a fresh nonce means a fresh purchase.
   */
  BuyItem: "shop:buy",
  /**
   * Sells `quantity` of `itemKey` back for its item definition's `sellValue` (§9 D11). Not scoped
   * to a shop NPC, unlike {@link ClientMessage.BuyItem}: a sell price is intrinsic to the item, not
   * authored per-shop, so there is no room-narrowed table to resolve against — only
   * `ITEM_DEFINITIONS` itself. `nonce` is the same per-attempt idempotency key {@link
   * ClientMessage.BuyItem} uses.
   */
  SellItem: "shop:sell",
  /**
   * Uses one unit of a consumable `itemKey` (§9 D10/D11, design §3 D5 — selfrestore, loss on a
   * dropped session accepted). Always exactly one unit; there is no `quantity`, {@link
   * ClientMessage.Attack}'s own "nothing more to say" minimalism. `nonce` is the same per-attempt
   * idempotency key {@link ClientMessage.BuyItem} uses.
   */
  UseItem: "item:use",
  /**
   * Picks a class (roadmap R05-a, design `docs/r05-classes-and-skills.md` D1/D9). Write-once: the
   * server never trusts `classKey` and answers with the account's *stored* class regardless —
   * {@link ClassChanged}/{@link ClassDenied} — which may not be the one this request named. No
   * `nonce`: unlike a shop request this cannot be retried into a different outcome (`chooseOnce`
   * is idempotent by construction), so there is nothing for a nonce to correlate.
   */
  ChooseClass: "class:choose",
  /**
   * Casts one skill (roadmap R05-b, design `docs/r05-classes-and-skills.md` D5/D6/D8). The client
   * names no target for a monster or self skill — {@link ClientMessage.Attack}'s own "the server
   * picks it, there is no monster to name that is not there" — only an ally-target skill (today,
   * `heal`) fills {@link UseSkillRequest.targetSessionId}, D6's table. `nonce` is not an idempotency
   * key the way {@link ClientMessage.BuyItem}'s is (a skill is never settled or written to a
   * ledger, `docs/decisions.md` 2026-09-18 R05-b) — it exists only to correlate a {@link
   * SkillDenied} answer to the attempt it refuses.
   */
  UseSkill: "skill:use",
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

/**
 * The eight equipment slots (design-phase-v-equipment-system.md §1.1). `Ring1`/`Ring2` are two
 * concrete slots of the same "ring" family (§1.3) — a request names the concrete slot it wants,
 * never just "a ring", so a client with two rings never leaves the server to guess which one it
 * meant.
 */
export const EquipmentSlot = {
  Armor: "armor",
  Helmet: "helmet",
  Ring1: "ring1",
  Ring2: "ring2",
  Necklace: "necklace",
  Shoes: "shoes",
  Weapon: "weapon",
  Cloak: "cloak",
} as const;
export type EquipmentSlot = (typeof EquipmentSlot)[keyof typeof EquipmentSlot];

export interface EquipmentMetadata {
  slot: Exclude<EquipmentSlot, "ring1" | "ring2"> | "ring";
  attackDamage: number;
  damageReduction: number;
  requirement?: EquipmentRequirement;
}

export interface EquipmentRequirement {
  minLevel?: number;
  classes?: readonly PlayerClassKey[];
}

/** Every concrete slot, in the order `EquipmentSlot` declares them. */
export const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = Object.values(EquipmentSlot);

/**
 * Names the item to equip and the slot to put it in. An unknown key, one with no `equipment`
 * stats, or a slot whose family does not match the item's (design §1.3) is ignored.
 */
export interface EquipItemRequest {
  itemKey: string;
  slot: EquipmentSlot;
}

/** Names the slot to clear. A slot that is already empty is a no-op (`applied: false`), not an error. */
export interface UnequipItemRequest {
  slot: EquipmentSlot;
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

/**
 * Names a landmark by id (`LANDMARK_DEFINITIONS`). Ignored in silence if it belongs to a
 * landmark in a different room — that case has no fallback destination worth sending, unlike a
 * join, which always has a spawn to fall back to.
 */
export interface WarpToLandmarkRequest {
  landmarkId: string;
}

/**
 * Names a quest by id ({@link QuestState.questId}, from the offer the NPC panel carried). Ignored
 * in silence when this room holds no NPC offering it — an unknown id, or one belonging to a giver
 * in another room, the same room-narrowed boundary {@link QuizAnswerRequest} resolves against.
 *
 * Unlike a quiz answer this one *stores* something, so the boundary is doing real work here rather
 * than only tidying: what it bounds is which quests a client can open a row for. It is deliberately
 * not a position check — the room keeps no interaction state to check one against. A completed
 * quest can now pay out (roadmap R04-b), but that payout is settled once, server-side, off the
 * account's own stored progress — accepting one more time than intended still only ever produces
 * the same idempotent replay, never a second reward.
 */
export interface AcceptQuestRequest {
  questId: string;
}

/** See {@link ClientMessage.BuyItem}. */
export interface BuyItemRequest {
  npcObjectId: string;
  itemKey: string;
  /** Positive integer; total cost is the shop's per-unit price times this. */
  quantity: number;
  /** Client-generated idempotency key for this one purchase attempt (design §9 D8). */
  nonce: string;
}

/** See {@link ClientMessage.SellItem}. */
export interface SellItemRequest {
  itemKey: string;
  /** Positive integer. */
  quantity: number;
  /** Client-generated idempotency key for this one sale attempt (design §9 D8). */
  nonce: string;
}

/** See {@link ClientMessage.UseItem}. */
export interface UseItemRequest {
  itemKey: string;
  /** Client-generated idempotency key for this one use attempt (design §9 D8). */
  nonce: string;
}

/**
 * See {@link ClientMessage.ChooseClass}. `classKey` is untyped `string` on the wire, not
 * {@link PlayerClassKey} — the whole point of this request is that the server validates it,
 * {@link BuyItemRequest.itemKey}'s own "never trust the shape a client claims" treatment applied
 * to a closed set instead of a table.
 */
export interface ChooseClassRequest {
  classKey: string;
}

/**
 * See {@link ClientMessage.UseSkill}. `skillKey` is untyped `string` on the wire, {@link
 * ChooseClassRequest.classKey}'s own reason — the server validates it against this session's class,
 * not the client. `targetSessionId` is present only for an ally-target skill; a monster or self
 * skill ignores it if the client sends one anyway.
 */
export interface UseSkillRequest {
  skillKey: string;
  targetSessionId?: string;
  /** Client-generated correlation key for this one attempt — see {@link ClientMessage.UseSkill}. */
  nonce: string;
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
  [ClientMessage.UnequipItem]: UnequipItemRequest;
  [ClientMessage.ChangeSkin]: ChangeSkinRequest;
  [ClientMessage.WarpToLandmark]: WarpToLandmarkRequest;
  [ClientMessage.AcceptQuest]: AcceptQuestRequest;
  [ClientMessage.BuyItem]: BuyItemRequest;
  [ClientMessage.SellItem]: SellItemRequest;
  [ClientMessage.UseItem]: UseItemRequest;
  [ClientMessage.ChooseClass]: ChooseClassRequest;
  [ClientMessage.UseSkill]: UseSkillRequest;
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
  BossTelegraph: "combat:boss-telegraph",
  BossTelegraphCancelled: "combat:boss-telegraph-cancelled",
  PlayerAction: "player:action",
  ItemGranted: "inventory:granted",
  EquipmentChanged: "equipment:changed",
  /** design-phase-w-level-system.md §6 — one kill's EXP, and a level-up if this pushes past one. */
  ExpGranted: "progress:exp-granted",
  /** roadmap R03 — one quest's state after it changed, and once per accepted quest at join. */
  QuestUpdated: "quest:updated",
  /** roadmap R04-b — the account's currency balance changed, and once as a plain sync at join. */
  CurrencyChanged: "currency:changed",
  /** roadmap R04-c — a stack shrank from a sale or a consumable use (design §9 D12). */
  ItemRemoved: "inventory:removed",
  /** roadmap R04-c — a shop/consumable request was refused (design §9 D12/D13). */
  ShopDenied: "shop:denied",
  /**
   * roadmap R05-a — the account's chosen class, or the lack of one (design `docs/r05-classes-
   * and-skills.md` D3/D9). Sent once at join as a plain sync — {@link CurrencyChanged}'s own
   * `"sync"` precedent — with `classKey: null` for an account that has never chosen, and again
   * after a successful {@link ClientMessage.ChooseClass}.
   */
  ClassChanged: "class:changed",
  /** roadmap R05-a — a class:choose request was refused, {@link ShopDenied}'s precedent. */
  ClassDenied: "class:denied",
  /**
   * roadmap R05-b — a `skill:use` resolved. Sent to every viewer within VIEW_RADIUS_TILES of the
   * caster, {@link MonsterHit}'s own audience shape, so the cast is visible the same way a swing
   * is. Skill damage itself still rides {@link MonsterHit}, not this message (design §2 D8).
   */
  SkillUsed: "skill:used",
  /** roadmap R05-b — a `skill:use` request was refused, {@link ShopDenied}'s precedent. */
  SkillDenied: "skill:denied",
  /** roadmap R05-b — an ally-heal skill restored HP, sent to both the caster and the target. */
  PlayerHealed: "player:healed",
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
  Npc: "npc",
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
  /**
   * Whether standing on this tile should hold the player in place — and block the home/landmark
   * warp — until the panel is closed. True for every object placed in a genuine dead end (the
   * existing convention, docs/design-fixed-objects.md); false only when an author has knowingly
   * placed one on a through-route for visibility, e.g. the entrance NPC
   * (docs/design-npc-movement-block-fix.md). Always a concrete boolean on the wire: the server
   * resolves `InteractableBase.blocksMovement ?? true` once in `toInteraction`, so no client call
   * site repeats that default.
   */
  blocksMovement: boolean;
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
 * Where one account stands on one quest. Three states and no fourth: a quest is offered until it is
 * accepted, active until its objective is met, and completed for good after that. There is no
 * "turned in" — handing a quest back is a payout, and payout is R04's.
 */
export const QuestStatus = {
  /** Never accepted by this account. Only an NPC panel ever carries this one. */
  Offered: "offered",
  Accepted: "accepted",
  Completed: "completed",
} as const;
export type QuestStatus = (typeof QuestStatus)[keyof typeof QuestStatus];

/**
 * One quest as the client is told about it — the whole row, text included, so the client holds no
 * quest table of its own. {@link ItemGranted.name}'s reasoning, applied to a bigger payload: a
 * browser running a bundle older than the server still renders exactly what it was handed, and
 * retuning a requirement or rewriting an NPC's line stays a server deploy.
 *
 * Travels two ways: inside {@link NpcInteraction.quests} when the giver's panel opens, and on its
 * own as {@link ServerMessage.QuestUpdated} whenever the stored state changes. One shape for both,
 * because "what the panel shows" and "what just changed" are the same fact — a second shape would
 * be two renderers that have to agree.
 */
export interface QuestState {
  questId: string;
  title: string;
  /** The giver's offer text. Newlines are significant, {@link NoticeInteraction.body}'s own terms. */
  summary: string;
  /** The objective in words, e.g. "사냥터에서 다람쥐 3마리 처치". */
  objectiveText: string;
  /** Shown once `status` is `Completed`; sent in every state so the client needs no second fetch. */
  completionText: string;
  status: QuestStatus;
  /**
   * Kills credited, and the requirement they are counted against. Both travel even while
   * `objectiveText` already spells the requirement out: that string is prose for a person, these
   * two are the progress bar, and deriving one from the other in either direction is how a UI
   * starts parsing copy.
   *
   * `killCount` is 0 while `status` is `Offered`, and never exceeds `requiredCount`.
   */
  killCount: number;
  requiredCount: number;
  prerequisiteQuestId?: string;
  blocked?: boolean;
}

/**
 * One item a shop NPC sells, resolved for display — the {@link QuestState} treatment applied to a
 * shop row: the whole thing travels, including text, so a client older than `ShopDefinition`
 * (server/src/rooms/shopDefinitions.ts) still renders exactly what it was handed.
 */
export interface ShopListingView {
  itemKey: string;
  name: string;
  icon: string;
  /** 전(錢), per unit. Never trusted back from the client — {@link BuyItemRequest} sends no price. */
  price: number;
  attackBonus?: number;
  damageReductionRatio?: number;
  equipment?: EquipmentMetadata;
}

/** What one shop NPC offers, in authored (display) order — design §9 D11. */
export interface ShopOffer {
  listings: readonly ShopListingView[];
}

/** Same shape as {@link NoticeInteraction} — the panel is identical; only the marker differs. */
export interface NpcInteraction extends InteractionBase {
  kind: typeof InteractableKind.Npc;
  /** Newlines are significant, exactly like {@link NoticeInteraction.body}. */
  body: string;
  /**
   * What this NPC offers, with the reader's own state already resolved into each row — absent
   * entirely (not an empty array) for an NPC that gives no quests, which is every row but the
   * plaza guide today.
   *
   * An array because the authored table does not forbid one giver offering several, and a field
   * that silently showed only the first would make the table's meaning depend on its order.
   */
  quests?: readonly QuestState[];
  /**
   * This NPC's shop listing, absent for an NPC that sells nothing — {@link NpcInteraction.quests}'
   * own "absent, not empty" convention, and independent of it: an NPC may offer quests, a shop,
   * both or neither (design §9 D11).
   */
  shop?: ShopOffer;
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
export type InteractableEntered =
  | LinkInteraction
  | NoticeInteraction
  | QuizInteraction
  | NpcInteraction;

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

export interface BossTelegraph {
  monsterId: string;
  targetTileX: number;
  targetTileY: number;
  radiusTiles: number;
  /** Positive milliseconds between the warning and its planned resolution. */
  windupMs: number;
  resolvesAt: number;
  phase: 1 | 2;
}

export interface BossTelegraphCancelled {
  monsterId: string;
}

export interface PlayerAction {
  sessionId: string;
  action: "attack" | "cast" | "hit" | "death";
  facing: Direction;
  at: number;
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
  equipment?: EquipmentMetadata;
  /**
   * Fraction of incoming monster damage this item removes while equipped, present only for an
   * equipment item. Sent so the bag's toast can show the stat without the client holding a
   * catalogue of its own.
   */
  damageReductionRatio?: number;
  sellValue?: number;
  consumable?: boolean;
}

/**
 * A stack shrank: a sale (`reason: "shop-sell"`) or a consumable use (`reason: "consume"`) —
 * {@link ItemGranted}'s own shape, mirrored rather than turned into a signed `quantity` on that
 * type, so a client reading "how many arrived" never has to remember that a shrink is a grant with
 * a negative sign (design §9 D12).
 *
 * Sent only once the store has committed it, {@link ItemGranted}'s own ordering guarantee.
 */
export interface ItemRemoved {
  itemKey: string;
  /** Same terms as {@link ItemGranted.name}. */
  name: string;
  /** Same terms as {@link ItemGranted.icon}. */
  icon: string;
  /** How many were removed this time. */
  quantity: number;
  /** Total held afterwards; 0 means the stack is gone and the row disappears from the bag. */
  total: number;
  reason: "shop-sell" | "consume";
  /**
   * Present only when `reason` is `"consume"` and the item restored HP — {@link
   * ItemGranted.damageReductionRatio}'s own "only this variant sets it" convention. Paired with
   * `hpRemaining`/`hpMax`, {@link PlayerHit}'s own fields, so a consuming client updates its vitals
   * bar off this one message instead of inferring a heal from the item's own catalogue entry.
   */
  hpRestored?: number;
  hpRemaining?: number;
  hpMax?: number;
}

/**
 * The result of one equip or unequip request. Unicast to the requester and to nobody else — the
 * same rule as {@link PlayerHit}: what somebody else has equipped is their own business.
 */
export interface EquipmentChanged {
  /** Which of the eight slots this verdict is about. */
  slot: EquipmentSlot;
  /** What is equipped in `slot` after this request, or null if nothing is. */
  itemKey: string | null;
  /**
   * False when an equip named an item the account does not hold, or lost a same-account,
   * different-tab concurrent equip race — or when an unequip found nothing equipped. Always the
   * store's own answer, never a locally-cached guess, so the state above is unchanged only when
   * this is false.
   */
  applied: boolean;
}

/**
 * One kill's EXP, unicast to the killer only — {@link ItemGranted}'s own shape and reason.
 * `hpRemaining === 0` is never sent here (a level-up cannot happen while dead: `awardExp` only
 * runs after a kill, and killing requires being alive) — {@link PlayerHit}'s death notice, not
 * this message, remains the one source of "you died".
 *
 * No separate "level up" message: if `level` is greater than what the client already believed,
 * that rise *is* the level-up notice — the same "two messages that always travel together are one
 * message" reasoning {@link MonsterHit}'s own doc comment gives.
 */
export interface ExpGranted {
  monsterId: string;
  /** EXP this one kill granted. */
  amount: number;
  /** Cumulative EXP after this grant — the server's own truth, never a client-side running total. */
  totalExp: number;
  /** The level `totalExp` maps to. Greater than what the client last knew is the level-up itself. */
  level: number;
  /** EXP still needed for the next level, or `null` once `level` has reached the cap. */
  expToNextLevel: number | null;
  /**
   * Paired with {@link PlayerHit}'s own hp fields: a level-up is always a full heal (design §6), so
   * `hpRemaining === hpMax` here whenever `level` just rose. When it did not, these simply echo the
   * session's current numbers — the same "next message carries the server's real number" correction
   * {@link PlayerHit} already relies on, applied here since a kill is also the moment `hpMax` itself
   * may have just grown (a level's `totalMaxHp`, design §4.2).
   */
  hpMax: number;
  hpRemaining: number;
}

/**
 * The account's currency balance changed (design `docs/r04-settlement.md` §4 D7). Two causes
 * today: `"quest"` for a completed quest's reward (`docs/decisions.md` 2026-09-17 — 화폐만, 소액),
 * and `"sync"` for the one-time push at join that gives a client with no schema field for
 * currency (nobody but the owner needs to see it, {@link PlayerHit.hpRemaining}'s own reasoning)
 * something to show before its first grant — `delta` is 0 for that one. `"shop-buy"`/`"shop-sell"`
 * are R04-c's additions (design §9 D12): a successful {@link ClientMessage.BuyItem}/{@link
 * ClientMessage.SellItem} sends this instead of a new "purchase complete" wrapper — D7's own
 * decision extended, not reopened. {@link ClientMessage.UseItem} never sends this: a consumable
 * moves no currency.
 */
export interface CurrencyChanged {
  /** Balance after this change — the server's own truth, never a client-side running total. */
  balance: number;
  /** How much `balance` moved by this message; 0 for the join-time sync. */
  delta: number;
  reason: "quest" | "sync" | "shop-buy" | "shop-sell";
}

/**
 * Every reason a {@link ClientMessage.BuyItem}/{@link ClientMessage.SellItem}/{@link
 * ClientMessage.UseItem} can be refused (design §9 D13). Distinguished for the client so a
 * "잔액 부족" toast never reads as "가방이 가득 찼습니다":
 *
 * - `insufficient-balance` — cannot afford the purchase.
 * - `bag-full` — the purchase would add a new distinct item past `MAX_DISTINCT_ITEMS`.
 * - `insufficient-item` — selling or using more units than the account holds.
 * - `unknown-item` — `itemKey` names no row in `ITEM_DEFINITIONS` at all (a client/server skew).
 * - `not-sold-here` — the item exists, but this shop's listing does not carry it (this project's
 *   stand-in for "품절": shops have no stock model to run out of, design §9 D11).
 * - `not-sellable` — the item exists but has no `sellValue`.
 * - `not-consumable` — the item exists but has no `consumable` effect.
 */
export type ShopDenialReason =
  | "insufficient-balance"
  | "bag-full"
  | "insufficient-item"
  | "unknown-item"
  | "not-sold-here"
  | "not-sellable"
  | "not-consumable";

/**
 * A shop/consumable request was refused, sent instead of any state message — the
 * {@link PortalEntered}/{@link PortalDenied} pairing's own shape: success is told by whatever
 * actually changed ({@link CurrencyChanged}, {@link ItemGranted}, {@link ItemRemoved}), and only a
 * refusal needs a message of its own.
 */
export interface ShopDenied {
  action: "buy" | "sell" | "use";
  itemKey: string;
  reason: ShopDenialReason;
}

/**
 * The account's chosen class, or the lack of one (roadmap R05-a, design `docs/r05-classes-and-
 * skills.md` D1/D3/D9). `classKey`/`classCode` are the same fact in both forms — the wire's own
 * string and the schema's own code — so a client never has to derive one from the other.
 *
 * `hpRemaining`/`hpMax`/`mpRemaining`/`mpMax` ride along rather than arriving as a follow-up
 * message: a class pick can move both caps in the same instant (D4), and splitting that across
 * two messages would let a client apply one half before the other lands.
 */
export interface ClassChanged {
  classKey: PlayerClassKey | null;
  classCode: number;
  hpRemaining: number;
  hpMax: number;
  mpRemaining: number;
  mpMax: number;
}

/**
 * A {@link ClientMessage.ChooseClass} request was refused, {@link ShopDenied}'s own "a refusal
 * needs a message of its own" shape.
 *
 * - `unknown-class` — `classKey` names none of the four classes.
 * - `already-chosen` — the account already holds a *different* class than the one requested. Sent
 *   alongside a {@link ClassChanged} carrying the account's actual, stored class (design §2 D1):
 *   the store is the single source of truth, and the picker has to settle on it rather than keep
 *   showing what the player just clicked. Re-requesting the *same* class the account already
 *   holds is not this — `chooseOnce`'s idempotent replay sends {@link ClassChanged} alone.
 */
export interface ClassDenied {
  reason: "unknown-class" | "already-chosen";
}

/**
 * A `skill:use` resolved (roadmap R05-b, design §2 D8). `mpRemaining`/`mpMax` ride along only in
 * the caster's own copy — {@link ClassChanged}'s "nobody but the owner needs to see it" rule
 * applied to MP a second time (design §3 D3) — so onlookers get a copy of this message with those
 * two keys entirely absent, not merely `undefined`. `targetSessionId` is set only for an ally-heal
 * cast; a monster or self skill leaves it unset and relies on {@link MonsterHit}/the cast animation
 * to say what was targeted.
 */
export interface SkillUsed {
  skillKey: string;
  casterSessionId: string;
  targetSessionId?: string;
  cooldownUntil: number;
  mpRemaining?: number;
  mpMax?: number;
}

/**
 * The reasons `handleUseSkill` can refuse a {@link ClientMessage.UseSkill} (design §2 D8, checked
 * in this order — `docs/decisions.md` 2026-09-18 R05-b 미결 3):
 *
 * - `no-class` — the account has not chosen a class yet, so it has no skills at all.
 * - `unknown-skill` — `skillKey` names no real skill, or one this session's class does not have.
 * - `on-cooldown` — this skill's own cooldown (independent of every other skill's and of the
 *   auto-attack's, design §2 D5) has not elapsed.
 * - `insufficient-mp` — the account does not have `SkillDefinition.mpCost` MP to spend.
 * - `no-target` — a monster-target skill found nothing in range (including a room with no monsters
 *   at all), or an ally-target skill named no `targetSessionId`, or one that resolves to nobody in
 *   this room.
 * - `out-of-range` — an ally-target skill's named target exists in this room but is further than
 *   `SkillDefinition.rangeInTiles` away.
 * - `target-dead` — an ally-target skill's named target exists and is in range, but is not alive.
 */
export type SkillDenialReason =
  | "no-class"
  | "unknown-skill"
  | "on-cooldown"
  | "insufficient-mp"
  | "no-target"
  | "out-of-range"
  | "target-dead";

/**
 * A {@link ClientMessage.UseSkill} request was refused, {@link ShopDenied}'s own "a refusal needs a
 * message of its own" shape. `nonce` echoes the request's own — unlike {@link ShopDenied}, which
 * never needs to (a shop retry reuses the same nonce and the settlement store itself is the source
 * of truth) — because a skill is answered synchronously and a client casting in quick succession
 * needs to know which attempt this denial is about (design §2 D8's own stated purpose for `nonce`).
 */
export interface SkillDenied {
  skillKey: string;
  reason: SkillDenialReason;
  nonce: string;
}

/**
 * An ally-heal skill resolved (design §2 D8). Sent to both the caster and the target — two
 * different clients, unlike every other unicast message in this file — since neither one is
 * redundant: the target needs it for their own vitals bar and the caster needs it to know the cast
 * actually landed and for how much, the same feedback {@link MonsterHit} gives an attacker.
 */
export interface PlayerHealed {
  targetSessionId: string;
  healAmount: number;
  hpRemaining: number;
  hpMax: number;
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
  [ServerMessage.BossTelegraph]: BossTelegraph;
  [ServerMessage.BossTelegraphCancelled]: BossTelegraphCancelled;
  [ServerMessage.PlayerAction]: PlayerAction;
  [ServerMessage.ItemGranted]: ItemGranted;
  [ServerMessage.EquipmentChanged]: EquipmentChanged;
  [ServerMessage.ExpGranted]: ExpGranted;
  [ServerMessage.QuestUpdated]: QuestState;
  [ServerMessage.CurrencyChanged]: CurrencyChanged;
  [ServerMessage.ItemRemoved]: ItemRemoved;
  [ServerMessage.ShopDenied]: ShopDenied;
  [ServerMessage.ClassChanged]: ClassChanged;
  [ServerMessage.ClassDenied]: ClassDenied;
  [ServerMessage.SkillUsed]: SkillUsed;
  [ServerMessage.SkillDenied]: SkillDenied;
  [ServerMessage.PlayerHealed]: PlayerHealed;
}
