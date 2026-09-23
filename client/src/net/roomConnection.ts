import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";
import {
  ClientMessage,
  RoomState,
  ServerMessage,
  type AcceptQuestRequest,
  type BuyItemRequest,
  type BossTelegraph,
  type BossTelegraphCancelled,
  type ChangeSkinRequest,
  type ChatBroadcast,
  type ChatRequest,
  type ChooseClassRequest,
  type ClassChanged,
  type ClassDenied,
  type CurrencyChanged,
  type Direction,
  type EquipItemRequest,
  type EquipmentChanged,
  type EquipmentSlot,
  type ExpGranted,
  type InteractableEntered,
  type InteractableMarker,
  type ItemGranted,
  type ItemRemoved,
  type JoinOptions,
  type Monster,
  type MonsterHit,
  type MoveRejected,
  type MoveRequest,
  type Player,
  type PlayerClassKey,
  type PlayerHealed,
  type PlayerHit,
  type PlayerAction,
  type PortalDenied,
  type PortalEntered,
  type PortalMarker,
  type QuestState,
  type QuizAnswerRequest,
  type QuizResult,
  type SellItemRequest,
  type ShopDenied,
  type SkillDenied,
  type SkillKey,
  type SkillUsed,
  type Teleported,
  type TilePosition,
  type UnequipItemRequest,
  type UseItemRequest,
  type UseSkillRequest,
  type WarpToLandmarkRequest,
  type PartyChanged, type PartyInvited, type PartyDenied,
  type TradeChanged, type TradeDenied, type TradeOffer,
  type CraftingRecipes, type CraftResult, type InventoryInvalidated,
} from "@zep-test/shared";
import { resolveJoinOptions } from "./identity";

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
  /** Public like `nickname` (design-phase-w-level-system.md §2) — real from join, every room. */
  level: number;
  weaponItemKey?: string;
  armorItemKey?: string;
}

/**
 * Plain mirror of the synced `Monster` schema. No HP: it is not in the state at all, because a
 * hit would then patch every view in range — it rides on `MonsterHit` instead (design §5.2).
 *
 * `kind` stays the raw wire string rather than a union, like {@link InteractableMarkerPosition}:
 * the server can be newer than the browser holding this bundle, and `monsterSprites` only keeps
 * its fallback row reachable while this type admits that.
 */
export interface MonsterSnapshot {
  kind: string;
  tileX: number;
  tileY: number;
  facing: Direction;
}

/** Plain mirror of one synced `InteractableMarker`, like {@link PlayerSnapshot} for players. */
export interface InteractableMarkerPosition extends TilePosition {
  /**
   * An `InteractableKind` value, deliberately left as the raw wire string instead of narrowed to
   * the union this bundle knows: the server can be newer than the browser holding it, and the
   * marker renderer's fallback branch only stays reachable while this type admits that.
   */
  kind: string;
  avatarSkin?: number;
}

export interface RoomEvents {
  onPartyChanged?(event: PartyChanged): void;
  onPartyInvited?(event: PartyInvited): void;
  onPartyDenied?(event: PartyDenied): void;
  onTradeChanged?(event: TradeChanged): void;
  onTradeDenied?(event: TradeDenied): void;
  onCraftingRecipes?(event: CraftingRecipes): void;
  onCraftResult?(event: CraftResult): void;
  onInventoryInvalidated?(event: InventoryInvalidated): void;
  onPlayerAdd?(sessionId: string, player: PlayerSnapshot): void;
  onPlayerChange?(sessionId: string, player: PlayerSnapshot): void;
  onPlayerRemove?(sessionId: string): void;
  /** A monster entered this client's view radius, or respawned into an id it already knew. */
  onMonsterAdd?(monsterId: string, monster: MonsterSnapshot): void;
  onMonsterChange?(monsterId: string, monster: MonsterSnapshot): void;
  /**
   * The entry left `state.monsters` — death and leaving the view radius both arrive this way,
   * because the state makes them the same event (design §5.2). Whichever it was, the sprite goes.
   */
  onMonsterRemove?(monsterId: string): void;
  /**
   * A monster inside the view radius took a hit. The only path monster health takes to the
   * client, so a monster nobody has swung at has no health to draw; `hpRemaining === 0` is the
   * death notice, and the sprite still goes via {@link onMonsterRemove}.
   */
  onMonsterHit?(event: MonsterHit): void;
  /** The local player took a hit. Unicast: nobody else's health ever arrives here. */
  onPlayerHit?(event: PlayerHit): void;
  onPlayerAction?(event: PlayerAction): void;
  onBossTelegraph?(event: BossTelegraph): void;
  onBossTelegraphCancelled?(event: BossTelegraphCancelled): void;
  /** A drop was credited to this account, and the store has already committed it. */
  onItemGranted?(event: ItemGranted): void;
  /** The account's equipped item slot changed — or an equip/unequip request was ignored. */
  onEquipmentChanged?(event: EquipmentChanged): void;
  /** One kill's EXP, unicast to the killer. A `level` greater than what was last known is a level-up. */
  onExpGranted?(event: ExpGranted): void;
  onChat?(message: ChatBroadcast): void;
  onMoveRejected?(correction: MoveRejected): void;
  /** The local player stepped onto a portal trigger; the consumer owns the room transition. */
  onPortalEntered?(event: PortalEntered): void;
  /** The step landed on a portal trigger the player lacks the item for; no room transition. */
  onPortalDenied?(event: PortalDenied): void;
  /** The local player stepped onto a fixed object; the payload carries everything to draw it. */
  onInteractableEntered?(event: InteractableEntered): void;
  /** Verdict on one {@link RoomConnection.sendQuizAnswer}, possibly after its panel has closed. */
  onQuizResult?(result: QuizResult): void;
  /**
   * One quest's stored state after it changed — an accept, a kill that counted, or the kill that
   * finished it. Also fires once per already-accepted quest right after join, which is how a
   * tracker built for this room learns what the account is already carrying (roadmap R03).
   */
  onQuestUpdated?(state: QuestState): void;
  /**
   * The account's currency balance changed — a settled quest reward, or the plain sync sent once
   * at join (`reason: "sync"`). Also fires before `attach()` for the sync's own reason
   * {@link onQuestUpdated}'s doc comment gives: the room hydrates it the moment it has it.
   */
  onCurrencyChanged?(event: CurrencyChanged): void;
  /**
   * A bag stack shrank from a sale or a consumable use (roadmap R04-c, design §9 D12). Always a
   * reply to a message this client sent, so unlike `onCurrencyChanged`'s join-time sync there is
   * nothing to buffer before `attach()`.
   */
  onItemRemoved?(event: ItemRemoved): void;
  /**
   * One `shop:buy`/`shop:sell`/`item:use` was refused (design §9 D12/D13) — sent instead of any
   * state message, {@link onPortalDenied}'s own pairing.
   */
  onShopDenied?(event: ShopDenied): void;
  /**
   * The account's chosen class, or the lack of one (roadmap R05-a, design `docs/r05-classes-and-
   * skills.md` D9) — `classKey: null` for an account that has never chosen. Also fires before
   * `attach()` for {@link onCurrencyChanged}'s own reason: the room sends this the moment it has
   * read the class, which lands during the map-loading window this class is alive for and
   * `attach()` is not.
   */
  onClassChanged?(event: ClassChanged): void;
  /** One `class:choose` this client sent was refused (design D9) — {@link onShopDenied}'s own pairing. */
  onClassDenied?(event: ClassDenied): void;
  /**
   * A skill cast resolved (roadmap R05-b/-c) — fires for *every* cast within view, not only ours,
   * so the cast animation plays for the caster the same way a swing does. Only the caster's own
   * copy carries `mpRemaining`/`mpMax`: an onlooker's copy omits those two keys entirely (design
   * §3 D3), so a consumer must compare `casterSessionId` before reading them.
   */
  onSkillUsed?(event: SkillUsed): void;
  /** One `skill:use` this client sent was refused (design §2 D8) — {@link onShopDenied}'s own pairing. */
  onSkillDenied?(event: SkillDenied): void;
  /**
   * An ally-heal landed (design §2 D8). Arrives at both the caster and the target, so a self-heal
   * produces exactly one message rather than two (`metaverseRoom.ts:1203`).
   */
  onPlayerHealed?(event: PlayerHealed): void;
  /** The server warped the local player. Apply as an absolute position, never as a step. */
  onTeleported?(event: Teleported): void;
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
  private readonly monsterSnapshots = new Map<string, MonsterSnapshot>();
  /** Kept apart from `detachers`: a monster id and a session id share no namespace. */
  private readonly monsterDetachers = new Map<string, () => void>();
  private events: RoomEvents = {};
  private attached = false;
  private leaving = false;
  private left = false;
  private pendingLifecycle: PendingLifecycle | null = null;
  /**
   * Quest updates that arrived before `attach()` had a tracker to draw them on. Unlike every other
   * message here, these are caused by the *join* rather than by something the player did: the room
   * hydrates an account's accepted quests the moment it has them and sends one per quest, which
   * lands during the whole map-loading window this class is alive for and `attach()` is not. An
   * unhandled Colyseus message is dropped, so without this queue a hop into a second room would
   * show an empty quest tracker until the next kill.
   */
  private readonly pendingQuestUpdates: QuestState[] = [];
  /**
   * Currency changes that arrived before `attach()` had a bag panel to draw them on — the same
   * queue as {@link pendingQuestUpdates}, and for the same reason: the room sends the join-time
   * `"sync"` message the moment it has read the balance, which lands during the map-loading window
   * this class is alive for and `attach()` is not.
   */
  private readonly pendingCurrencyChanges: CurrencyChanged[] = [];
  /** {@link pendingCurrencyChanges}'s own queue and reason, against the join-time `class:changed` sync. */
  private readonly pendingClassChanges: ClassChanged[] = [];
  private pendingSocial: (() => void)[] = [];

  private constructor(
    private readonly room: Room<unknown, RoomState>,
    /**
     * The matchmaking name this connection joined by. Not read from `RoomState`, which carries
     * `roomType` — a different concept that only happens to match today. The client passed this
     * name to `connect()`, so it is already the authority on it.
     */
    readonly roomName: string,
    /** Read from RoomState, so the client can never disagree with the server about the map. */
    readonly mapKey: string,
    /**
     * Where this room's portal triggers are, for drawing an in-world marker. Copied once like
     * `mapKey`, not held as the schema array: the server writes these in `onCreate` and never
     * again, and renderers never hold schema instances.
     */
    readonly portalMarkers: readonly TilePosition[],
    /**
     * Where this room's fixed objects are and which kind each one is — position only, never their
     * content, which arrives with `InteractableEntered` on the step that enters the tile. Copied
     * once for the same reason as {@link portalMarkers}.
     */
    readonly interactableMarkers: readonly InteractableMarkerPosition[],
  ) {
    this.bindLifecycle();
    this.bindQuestUpdates();
    this.bindCurrencyChanges();
    this.bindClassChanges();
    this.bindSocialMessages();
  }

  /**
   * Joins `roomName` and resolves only once the first state has arrived, so `mapKey`, the marker
   * arrays and `players` are populated: `joinOrCreate` alone resolves on the JOIN_ROOM frame,
   * which precedes ROOM_STATE by an ack round trip.
   */
  static async connect(roomName: string, options?: JoinOptions): Promise<RoomConnection> {
    const client = new Client(resolveEndpoint());
    const room = await client.joinOrCreate<RoomState>(
      roomName,
      options ?? resolveJoinOptions(),
      RoomState,
    );
    await firstState(room);
    return new RoomConnection(
      room,
      roomName,
      room.state.mapKey,
      toMarkers(room.state.portalMarkers),
      toInteractableMarkers(room.state.interactableMarkers),
    );
  }

  /** Wires renderers. `onPlayerAdd` fires at once for everyone already in view. */
  attach(events: RoomEvents): void {
    this.events = events;
    this.attached = true;
    this.bindPlayers();
    this.bindMonsters();
    this.bindMessages();
    this.replayPendingLifecycle();
    this.replayPendingQuestUpdates();
    this.replayPendingCurrencyChanges();
    this.replayPendingClassChanges();
    const pendingSocial = this.pendingSocial.splice(0);
    queueMicrotask(() => pendingSocial.forEach((deliver) => deliver()));
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  /** True once this room has closed, whether we asked for it or the socket dropped. */
  get hasLeft(): boolean {
    return this.left;
  }

  /** Every player currently inside this client's view radius, including itself. */
  get players(): ReadonlyMap<string, PlayerSnapshot> {
    return this.snapshots;
  }

  /** Every live monster inside this client's view radius. Empty in a room that has none. */
  get monsters(): ReadonlyMap<string, MonsterSnapshot> {
    return this.monsterSnapshots;
  }

  sendMove(dir: Direction): void {
    this.room.send(ClientMessage.Move, { dir } satisfies MoveRequest);
  }

  sendChat(text: string): void {
    this.room.send(ClientMessage.Chat, { text } satisfies ChatRequest);
  }

  createParty(): void { this.room.send(ClientMessage.CreateParty); }
  inviteParty(targetSessionId: string): void { this.room.send(ClientMessage.InviteParty, { targetSessionId }); }
  respondParty(inviteId: string, accept: boolean): void { this.room.send(ClientMessage.RespondPartyInvite, { inviteId, accept }); }
  leaveParty(): void { this.room.send(ClientMessage.LeaveParty); }
  requestTrade(targetSessionId: string): void { this.room.send(ClientMessage.RequestTrade, { targetSessionId }); }
  respondTrade(tradeId: string, accept: boolean): void { this.room.send(ClientMessage.RespondTrade, { tradeId, accept }); }
  updateTrade(tradeId: string, revision: number, offer: TradeOffer): void {
    this.room.send(ClientMessage.UpdateTradeOffer, { tradeId, revision, offer });
  }
  confirmTrade(tradeId: string, revision: number): void { this.room.send(ClientMessage.ConfirmTrade, { tradeId, revision }); }
  cancelTrade(tradeId: string): void { this.room.send(ClientMessage.CancelTrade, { tradeId }); }
  craftItem(recipeId: string, nonce: string): void { this.room.send(ClientMessage.CraftItem, { recipeId, nonce }); }

  private bindSocialMessages(): void {
    const deliver = (callback: () => void): void => {
      if (this.attached) callback();
      else this.pendingSocial.push(callback);
    };
    this.room.onMessage(ServerMessage.PartyChanged, (event: PartyChanged) => deliver(() => this.events.onPartyChanged?.(event)));
    this.room.onMessage(ServerMessage.PartyInvited, (event: PartyInvited) => deliver(() => this.events.onPartyInvited?.(event)));
    this.room.onMessage(ServerMessage.PartyDenied, (event: PartyDenied) => deliver(() => this.events.onPartyDenied?.(event)));
    this.room.onMessage(ServerMessage.TradeChanged, (event: TradeChanged) => deliver(() => this.events.onTradeChanged?.(event)));
    this.room.onMessage(ServerMessage.TradeDenied, (event: TradeDenied) => deliver(() => this.events.onTradeDenied?.(event)));
    this.room.onMessage(ServerMessage.CraftingRecipes, (event: CraftingRecipes) => deliver(() => this.events.onCraftingRecipes?.(event)));
    this.room.onMessage(ServerMessage.CraftResult, (event: CraftResult) => deliver(() => this.events.onCraftResult?.(event)));
    this.room.onMessage(ServerMessage.InventoryInvalidated, (event: InventoryInvalidated) => deliver(() => this.events.onInventoryInvalidated?.(event)));
  }

  /**
   * Asks to be warped to this room's home tile. No payload: the destination is the room's own
   * config, so there is nothing to say and nothing for the server to parse.
   */
  sendReturnHome(): void {
    this.room.send(ClientMessage.ReturnHome);
  }

  /**
   * Same-room half of the landmark panel — asks to be warped to this landmark's tile. The
   * cross-room half rejoins via `JoinOptions.arriveAtLandmark` instead of this message
   * (`docs/design-phase-m-landmark-teleport.md` §2.1).
   */
  sendWarpToLandmark(landmarkId: string): void {
    this.room.send(ClientMessage.WarpToLandmark, { landmarkId } satisfies WarpToLandmarkRequest);
  }

  /**
   * Answers one quiz object. The object is named rather than inferred from where we are standing,
   * because the server keeps no interaction state and grades whatever id its own table resolves.
   */
  sendQuizAnswer(objectId: string, choiceIndex: number): void {
    this.room.send(ClientMessage.QuizAnswer, { objectId, choiceIndex } satisfies QuizAnswerRequest);
  }

  /**
   * Accepts one quest by the id the NPC panel carried. Named rather than inferred from where we
   * are standing, for {@link sendQuizAnswer}'s reason: the server keeps no interaction state and
   * resolves the id against its own room-narrowed table, ignoring in silence one it does not hold.
   */
  sendAcceptQuest(questId: string): void {
    this.room.send(ClientMessage.AcceptQuest, { questId } satisfies AcceptQuestRequest);
  }

  /**
   * Buys `quantity` of `itemKey` from the shop NPC named by `npcObjectId` (design §9 D8/D10/D11).
   * `nonce` is generated by the caller once per purchase attempt and must be resent unchanged for a
   * retry of that same attempt — this method never generates one itself, so it cannot tell a retry
   * from a fresh purchase apart and must not be trusted to.
   */
  sendBuyItem(npcObjectId: string, itemKey: string, quantity: number, nonce: string): void {
    this.room.send(ClientMessage.BuyItem, {
      npcObjectId,
      itemKey,
      quantity,
      nonce,
    } satisfies BuyItemRequest);
  }

  /** {@link sendBuyItem}'s own nonce contract, against `shop:sell`. Not scoped to an NPC (design §9 D11). */
  sendSellItem(itemKey: string, quantity: number, nonce: string): void {
    this.room.send(ClientMessage.SellItem, { itemKey, quantity, nonce } satisfies SellItemRequest);
  }

  /** {@link sendBuyItem}'s own nonce contract, against `item:use`. Always exactly one unit. */
  sendUseItem(itemKey: string, nonce: string): void {
    this.room.send(ClientMessage.UseItem, { itemKey, nonce } satisfies UseItemRequest);
  }

  /**
   * Swings once. No payload, for {@link sendReturnHome}'s reason: the server picks what the swing
   * lands on from our own position and facing, so there is no monster to name. A swing that hits
   * nothing is answered with silence, and so is one inside the server's cooldown.
   */
  sendAttack(): void {
    this.room.send(ClientMessage.Attack);
  }

  /**
   * Casts one skill (roadmap R05-c). Names no target for a monster or self skill — the server
   * picks it, {@link sendAttack}'s own reason — so `targetSessionId` is filled only for an
   * ally-target skill. `nonce` correlates a possible `skill:denied` to this attempt and is not an
   * idempotency key: a skill is never settled to a ledger (`ChooseClass`'s own doc comment
   * distinguishes the two cases).
   */
  sendUseSkill(skillKey: SkillKey, nonce: string, targetSessionId?: string): void {
    this.room.send(ClientMessage.UseSkill, {
      skillKey,
      nonce,
      ...(targetSessionId === undefined ? {} : { targetSessionId }),
    } satisfies UseSkillRequest);
  }

  /** Requests the named item as the account's equipped item in `slot`. */
  sendEquipItem(itemKey: string, slot: EquipmentSlot): void {
    this.room.send(ClientMessage.EquipItem, { itemKey, slot } satisfies EquipItemRequest);
  }

  /** Requests that `slot` be cleared, no matter what is currently equipped there. */
  sendUnequipItem(slot: EquipmentSlot): void {
    this.room.send(ClientMessage.UnequipItem, { slot } satisfies UnequipItemRequest);
  }

  /**
   * Requests a live re-skin from the character menu. No reply: `avatarSkin` is a plain schema
   * field, so the normal `Player` patch is what carries it to every viewer, including this one.
   */
  sendChangeSkin(skin: number): void {
    this.room.send(ClientMessage.ChangeSkin, { skin } satisfies ChangeSkinRequest);
  }

  /**
   * Picks a class once (roadmap R05-a, design D1/D9). Write-once and idempotent server-side —
   * unlike {@link sendBuyItem} there is no nonce, since a resend of an already-settled pick cannot
   * be retried into a different outcome (`ChooseClass`'s own doc comment).
   */
  sendChooseClass(classKey: PlayerClassKey): void {
    this.room.send(ClientMessage.ChooseClass, { classKey } satisfies ChooseClassRequest);
  }

  /**
   * Hangs up on purpose, as the last step of a portal hop. `leaving` keeps the resulting
   * `room.onLeave` out of `RoomEvents.onLeave`, whose consumers treat a leave as a lost
   * connection and say so on screen.
   *
   * A room that is already gone resolves at once instead of hanging: `Room.leave()` waits on a
   * listener it registers itself, and `onLeave` is a signal with no replay, so a socket that
   * dropped a moment earlier — the tail of a portal hop is exactly such a moment — would never
   * settle that promise, and the caller would sit behind the wipe forever.
   *
   * That early return is silent by design, so the drop it swallowed is reported elsewhere:
   * `WorldScene.abandonTransition` reads {@link hasLeft} to tell a hop that merely failed from
   * one that also lost the room it started in. Removing either half hides a dead connection.
   */
  async leave(): Promise<void> {
    if (this.left) {
      return;
    }
    this.leaving = true;
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

  /**
   * The same shape as {@link bindPlayers}, against the second view-tagged map. Rooms without
   * monsters simply never fire: an empty map has nothing to replay, so plaza pays nothing for
   * this being wired unconditionally.
   */
  private bindMonsters(): void {
    const $ = getStateCallbacks(this.room);

    $(this.room.state).monsters.onAdd((monster: Monster, monsterId: string) => {
      this.monsterSnapshots.set(monsterId, toMonsterSnapshot(monster));
      this.events.onMonsterAdd?.(monsterId, toMonsterSnapshot(monster));

      this.monsterDetachers.set(
        monsterId,
        $(monster).onChange(() => {
          const snapshot = toMonsterSnapshot(monster);
          this.monsterSnapshots.set(monsterId, snapshot);
          this.events.onMonsterChange?.(monsterId, snapshot);
        }),
      );
    });

    $(this.room.state).monsters.onRemove((_monster: Monster, monsterId: string) => {
      this.monsterDetachers.get(monsterId)?.();
      this.monsterDetachers.delete(monsterId);
      this.monsterSnapshots.delete(monsterId);
      this.events.onMonsterRemove?.(monsterId);
    });
  }

  private bindMessages(): void {
    this.room.onMessage(ServerMessage.Chat, (message: ChatBroadcast) => {
      this.events.onChat?.(message);
    });
    this.room.onMessage(ServerMessage.MoveRejected, (correction: MoveRejected) => {
      this.events.onMoveRejected?.(correction);
    });
    this.room.onMessage(ServerMessage.PortalEntered, (event: PortalEntered) => {
      this.events.onPortalEntered?.(event);
    });
    this.room.onMessage(ServerMessage.PortalDenied, (event: PortalDenied) => {
      this.events.onPortalDenied?.(event);
    });
    this.room.onMessage(ServerMessage.Teleported, (event: Teleported) => {
      this.events.onTeleported?.(event);
    });
    this.room.onMessage(ServerMessage.InteractableEntered, (event: InteractableEntered) => {
      this.events.onInteractableEntered?.(event);
    });
    this.room.onMessage(ServerMessage.QuizResult, (result: QuizResult) => {
      this.events.onQuizResult?.(result);
    });
    this.room.onMessage(ServerMessage.MonsterHit, (event: MonsterHit) => {
      this.events.onMonsterHit?.(event);
    });
    this.room.onMessage(ServerMessage.PlayerHit, (event: PlayerHit) => {
      this.events.onPlayerHit?.(event);
    });
    this.room.onMessage(ServerMessage.PlayerAction, (event: PlayerAction) => {
      this.events.onPlayerAction?.(event);
    });
    this.room.onMessage(ServerMessage.BossTelegraph, (event: BossTelegraph) => {
      this.events.onBossTelegraph?.(event);
    });
    this.room.onMessage(ServerMessage.BossTelegraphCancelled, (event: BossTelegraphCancelled) => {
      this.events.onBossTelegraphCancelled?.(event);
    });
    this.room.onMessage(ServerMessage.ItemGranted, (event: ItemGranted) => {
      this.events.onItemGranted?.(event);
    });
    this.room.onMessage(ServerMessage.EquipmentChanged, (event: EquipmentChanged) => {
      this.events.onEquipmentChanged?.(event);
    });
    this.room.onMessage(ServerMessage.ExpGranted, (event: ExpGranted) => {
      this.events.onExpGranted?.(event);
    });
    this.room.onMessage(ServerMessage.ItemRemoved, (event: ItemRemoved) => {
      this.events.onItemRemoved?.(event);
    });
    this.room.onMessage(ServerMessage.ShopDenied, (event: ShopDenied) => {
      this.events.onShopDenied?.(event);
    });
    this.room.onMessage(ServerMessage.ClassDenied, (event: ClassDenied) => {
      this.events.onClassDenied?.(event);
    });
    this.room.onMessage(ServerMessage.SkillUsed, (event: SkillUsed) => {
      this.events.onSkillUsed?.(event);
    });
    this.room.onMessage(ServerMessage.SkillDenied, (event: SkillDenied) => {
      this.events.onSkillDenied?.(event);
    });
    this.room.onMessage(ServerMessage.PlayerHealed, (event: PlayerHealed) => {
      this.events.onPlayerHealed?.(event);
    });
  }

  /**
   * Registered here rather than in {@link bindMessages}, and exactly once: this is the one message
   * the server sends on its own initiative right after a join (see {@link pendingQuestUpdates}), so
   * a handler that only exists from `attach()` onwards would miss the account's own quest state.
   */
  private bindQuestUpdates(): void {
    this.room.onMessage(ServerMessage.QuestUpdated, (state: QuestState) => {
      if (!this.attached) {
        this.pendingQuestUpdates.push(state);
        return;
      }
      this.events.onQuestUpdated?.(state);
    });
  }

  /**
   * Registered here rather than in {@link bindMessages}, {@link bindQuestUpdates}'s own reason: the
   * join-time `"sync"` message is the server's own initiative, not a reply to anything this client
   * asked for, so a handler that only exists from `attach()` onwards would miss it.
   */
  private bindCurrencyChanges(): void {
    this.room.onMessage(ServerMessage.CurrencyChanged, (event: CurrencyChanged) => {
      if (!this.attached) {
        this.pendingCurrencyChanges.push(event);
        return;
      }
      this.events.onCurrencyChanged?.(event);
    });
  }

  /**
   * Registered here rather than in {@link bindMessages}, {@link bindCurrencyChanges}'s own reason:
   * the join-time sync is the server's own initiative, not a reply to anything this client asked
   * for, so a handler that only exists from `attach()` onwards would miss it.
   */
  private bindClassChanges(): void {
    this.room.onMessage(ServerMessage.ClassChanged, (event: ClassChanged) => {
      if (!this.attached) {
        this.pendingClassChanges.push(event);
        return;
      }
      this.events.onClassChanged?.(event);
    });
  }

  /**
   * A drop between `connect()` and `attach()` (the whole map-loading window) would otherwise
   * vanish into the empty `this.events`, leaving a world that renders and predicts movement
   * against a socket the server never sees. One slot is enough: a room terminates once.
   */
  private bindLifecycle(): void {
    this.room.onLeave((code, reason) => {
      // Recorded for every leave, wanted or not, because `leave()` reads it to stay non-blocking.
      this.left = true;
      if (this.leaving) {
        return;
      }
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
   * Deferred for {@link replayPendingLifecycle}'s reason, a different consumer of the same window:
   * `WorldScene.create()` builds the panels these updates draw on *after* `attach()` returns, so a
   * synchronous replay would deliver an account's quests to renderers that do not exist yet.
   * Drained rather than kept, since every later update arrives through the live handler.
   */
  private replayPendingQuestUpdates(): void {
    if (this.pendingQuestUpdates.length === 0) {
      return;
    }
    const pending = this.pendingQuestUpdates.splice(0);
    queueMicrotask(() => {
      for (const state of pending) {
        this.events.onQuestUpdated?.(state);
      }
    });
  }

  /** {@link replayPendingQuestUpdates}'s own shape and reason, against {@link pendingCurrencyChanges}. */
  private replayPendingCurrencyChanges(): void {
    if (this.pendingCurrencyChanges.length === 0) {
      return;
    }
    const pending = this.pendingCurrencyChanges.splice(0);
    queueMicrotask(() => {
      for (const event of pending) {
        this.events.onCurrencyChanged?.(event);
      }
    });
  }

  /** {@link replayPendingQuestUpdates}'s own shape and reason, against {@link pendingClassChanges}. */
  private replayPendingClassChanges(): void {
    if (this.pendingClassChanges.length === 0) {
      return;
    }
    const pending = this.pendingClassChanges.splice(0);
    queueMicrotask(() => {
      for (const event of pending) {
        this.events.onClassChanged?.(event);
      }
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

function toMarkers(markers: Iterable<PortalMarker>): TilePosition[] {
  const positions: TilePosition[] = [];
  for (const marker of markers) {
    positions.push({ tileX: marker.tileX, tileY: marker.tileY });
  }
  return positions;
}

function toInteractableMarkers(
  markers: Iterable<InteractableMarker>,
): InteractableMarkerPosition[] {
  const positions: InteractableMarkerPosition[] = [];
  for (const marker of markers) {
    positions.push({
      tileX: marker.tileX,
      tileY: marker.tileY,
      kind: marker.kind,
      avatarSkin: marker.avatarSkin,
    });
  }
  return positions;
}

function toMonsterSnapshot(monster: Monster): MonsterSnapshot {
  return {
    kind: monster.kind,
    tileX: monster.tileX,
    tileY: monster.tileY,
    // `facing` crosses the wire as uint8; the server only ever writes Direction values.
    facing: monster.facing as Direction,
  };
}

function toSnapshot(player: Player): PlayerSnapshot {
  return {
    nickname: player.nickname,
    tileX: player.tileX,
    tileY: player.tileY,
    // `facing` crosses the wire as uint8; the server only ever writes Direction values.
    facing: player.facing as Direction,
    avatarSkin: player.avatarSkin,
    level: player.level,
    weaponItemKey: typeof player.weaponItemKey === "string" ? player.weaponItemKey : "",
    armorItemKey: typeof player.armorItemKey === "string" ? player.armorItemKey : "",
  };
}
