import { StateView } from "@colyseus/schema";
import { Room, type AuthContext } from "colyseus";
import {
  ATTACK_COOLDOWN_MS,
  ATTACK_PER_LEVEL,
  ATTACK_RANGE_TILES,
  AVATAR_SKIN_COUNT,
  CHAT_RADIUS_TILES,
  COMBAT_EXIT_MS,
  COMBAT_RECOVERY_FRACTION_PER_TICK,
  ClientMessage,
  Direction,
  EQUIPMENT_SLOTS,
  EquipmentSlot,
  HOME_COOLDOWN_MS,
  HP_PER_LEVEL,
  InteractableKind,
  InteractableMarker,
  MAX_CHAT_LENGTH,
  MAX_CHATS_PER_SECOND,
  MAX_MOVES_PER_SECOND,
  MAX_NICKNAME_LENGTH,
  MONSTER_TICK_MS,
  Monster,
  PATCH_RATE_MS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_MAX_HP,
  Player,
  PortalMarker,
  QuestStatus,
  RoomState,
  ServerMessage,
  VIEW_RADIUS_TILES,
  cumulativeExpForLevel,
  levelForExp,
  remainingExpToNextLevel,
  type AcceptQuestRequest,
  type ChangeSkinRequest,
  type ChatBroadcast,
  type ChatRequest,
  type CurrencyChanged,
  type EquipItemRequest,
  type EquipmentChanged,
  type ExpGranted,
  type InteractableEntered,
  type ItemGranted,
  type JoinOptions,
  type MonsterHit,
  type MoveRejected,
  type MoveRequest,
  type PlayerHit,
  type PortalDenied,
  type PortalEntered,
  type QuestState,
  type QuizAnswerRequest,
  type QuizResult,
  type Teleported,
  type TilePosition,
  type UnequipItemRequest,
  type WarpToLandmarkRequest,
} from "@zep-test/shared";
import type { BossStateStore } from "../db/bossStateStore";
import type { CurrencyStore } from "../db/currencyStore";
import type { InventoryStore } from "../db/inventoryStore";
import type { ProgressStore } from "../db/progressStore";
import type { QuestRow, QuestStore } from "../db/questStore";
import type { SettlementOutcome, SettlementStore } from "../db/settlementStore";
import { TableInteractableIndex } from "../game/interactables";
import { TableLandmarkIndex } from "../game/landmarks";
import { rollLoot, type LootGrant } from "../game/loot";
import {
  decideMonsterAction,
  MonsterActionKind,
  MonsterAiState,
  type MonsterSnapshot,
  type MonsterTarget,
} from "../game/monsterAi";
import { isDirection, STEP_BY_DIRECTION, TileMovementResolver } from "../game/movement";
import { TablePortalIndex } from "../game/portals";
import { chebyshevDistance, UniformGridProximityIndex } from "../game/proximity";
import { TiledMapLoader } from "../game/tiledMap";
import type {
  AuthResult,
  CollisionMap,
  InteractableDefinition,
  InteractableIndex,
  LandmarkIndex,
  MetaverseRoomOptions,
  PlayerSession,
  PortalIndex,
  ProximityIndex,
  RoomCreateOptions,
  SpawnArea,
} from "./contracts";
import { slotFamily } from "./contracts";
import { INTERACTABLE_DEFINITIONS } from "./interactableDefinitions";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import { LANDMARK_DEFINITIONS } from "./landmarkDefinitions";
import {
  BOSS_RESPAWN_MS,
  MONSTER_SPAWN_DEFINITIONS,
  MONSTER_TYPES,
  type MonsterKind,
  type MonsterSpawnDefinition,
  type MonsterType,
} from "./monsterDefinitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";
import {
  QUESTS_BY_GIVER,
  QUESTS_BY_MONSTER_KIND,
  QUESTS_BY_ID,
  type QuestDefinition,
} from "./questDefinitions";
import { deriveSsoNickname, deriveSsoUserId } from "./ssoIdentity";

type RoomClient = MetaverseRoomOptions["client"];

const MIN_MOVE_INTERVAL_MS = 1000 / MAX_MOVES_PER_SECOND;
const MIN_CHAT_INTERVAL_MS = 1000 / MAX_CHATS_PER_SECOND;

/** Colyseus disconnects past this. Legitimate play peaks at 22 msg/s; the rest is burst headroom. */
const MAX_MESSAGES_PER_SECOND = 60;

/** Retry cap for spawn rejection sampling; past it the centre tile is used, which boot validates. */
const SPAWN_SAMPLE_ATTEMPTS = 16;

/**
 * Grace window after a boss fight's last combatant dies before an empty {@link BossCombatTracker}
 * counts as a wipe (design-phase-i-boss-monster.md §6.6, §11.4). Short on purpose: this absorbs
 * the same-tick race between the last death and the next reinforcement's first hit, not the walk
 * back from home — 5s is enough for someone already mid-fight to land another hit and cancel it,
 * not enough to make a genuine wipe feel like it lingers.
 */
const WIPE_RESET_GRACE_MS = 5000;

/**
 * Grid cell size for the proximity index. One more than the view radius because that is the
 * widest query the room issues (the move scan in {@link MetaverseRoom.refreshViewsAround}),
 * and it is the smallest cell for which such a query spans only 3x3 cells.
 *
 * A home warp breaks that premise — the same scan then queries `VIEW_RADIUS_TILES + warp
 * distance`, which across grand-plaza spans the whole grid. Answers stay exact; only the 3x3
 * cost bound is lost, which is what HOME_COOLDOWN_MS budgets for.
 */
const PROXIMITY_CELL_SIZE_TILES = VIEW_RADIUS_TILES + 1;

/**
 * Everything about one monster that is not in `state.monsters`: its rules, its FSM state and its
 * deadlines. Kept off the schema on purpose — none of it is anybody's business on the client, and
 * a field on the schema is a patch to every viewer within the radius each time it changes.
 *
 * There is one entry per spawn row for the room's whole life, alive or dead; `state.monsters`
 * holds only the living, so the two are read together.
 */
interface MonsterRuntime {
  readonly definition: MonsterSpawnDefinition;
  readonly type: MonsterType;
  state: MonsterAiState;
  nextStepAt: number;
  nextAttackAt: number;
  /** Only meaningful in the dead state. */
  respawnAt: number;
  /** Full at every spawn. Off the schema for the reason the whole of this interface is. */
  hp: number;
  /** Null until somebody hits it, and null again on respawn. */
  lastHitBy: LastHit | null;
  /**
   * Only meaningful for `type.isBoss` — null for every other kind. Kept on `MonsterRuntime`
   * itself rather than split into a separate boss-only runtime type: this interface already mixes
   * always-present-but-situationally-meaningful fields (`lastHitBy`, `respawnAt`), and
   * `monsterRuntimes` is one `Map` of one type populated by one loop ({@link populateMonsters}).
   */
  combat: BossCombatTracker | null;
}

/**
 * Participant tracking for the boss-only "wipe resets HP" rule (design §6.6). `combatants` is
 * who has hit, or been hit by, this boss and has not since died or left; `wipeResetAt` is null
 * while that set is non-empty or while nobody has emptied it yet.
 */
interface BossCombatTracker {
  /** sessionId. Added by {@link handleAttack}/{@link damagePlayer}, removed by {@link leaveBossCombat}. */
  combatants: Set<string>;
  /** Set the instant the last combatant leaves the fight; cleared to null by a new combatant or by {@link tick}. */
  wipeResetAt: number | null;
}

/**
 * Who last hit a monster, which is who its drops belong to. Holding the session *and* the account
 * is the whole of the rule: the account is what the grant is filed under, so it still lands after
 * the killer has walked out of the room, and the session is only the address the notification
 * would go to if they are still here.
 *
 * The rejected alternatives were destroying the drop when the killer leaves — there is nothing to
 * destroy, a bag belongs to an account and the grant is one statement — and passing it to the
 * next contributor, which would mean a damage ledger per monster and rules for clearing it.
 */
interface LastHit {
  /** Where an `ItemGranted` would go. Nothing is sent if that session has since left. */
  sessionId: string;
  /**
   * The account credited. Null outside SSO, where the session id stands in for it against the
   * in-memory store — see `PlayerSession.ownerKey`.
   */
  ownerKey: string | null;
}

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
  /**
   * False for every room with no monster row, which is every room but the hunting ground today.
   * Reading one boolean is the entire cost this feature puts on grand-plaza's move path, and that
   * is deliberate: PoC #2's measurements are the baseline this must not move.
   */
  private hasMonsters = false;
  /** Monster-only proximity index. Same class as the player one, separate instance. */
  private monsterIndex!: ProximityIndex;
  /** Per spawn row, alive or dead. See {@link MonsterRuntime}. */
  private readonly monsterRuntimes = new Map<string, MonsterRuntime>();
  /** Monster ids in each client's StateView. The monster half of {@link viewedBySession}. */
  private readonly monstersViewedBySession = new Map<string, Set<string>>();
  /**
   * Monsters have their own scratch buffers for the same reason the players do — one buffer per
   * query site — and they cannot borrow the player ones: "monsters near this player" and "players
   * near this monster" are different questions asked from different places, and a shared buffer
   * would be overwritten while the first answer was still being read.
   */
  private readonly monsterQueryBuffer: string[] = [];
  private readonly monsterNeighbourBuffer: string[] = [];
  private readonly monsterAggroBuffer: string[] = [];
  /** "Monsters within reach of this swing" — {@link pickAttackTarget}'s query and nothing else. */
  private readonly attackTargetBuffer: string[] = [];
  /** "Players who can see this monster" — the `MonsterHit` fan-out's query and nothing else. */
  private readonly hitAudienceBuffer: string[] = [];
  private readonly monstersInRange = new Set<string>();
  /** Rebuilt per monster per tick; the array itself is reused, the entries are not worth pooling. */
  private readonly monsterTargets: MonsterTarget[] = [];
  /**
   * Where drops are filed, handed over at `define()` time. Null in every room built without one —
   * the tests, the load-test harness, `npm run dev` — where a kill still resolves and simply
   * credits nothing.
   */
  private inventoryStore: InventoryStore | null = null;
  /** Where a boss's defeat time is filed. Null in every room built without one — see {@link RoomCreateOptions.bossStateStore}. */
  private bossStateStore: BossStateStore | null = null;
  /** Where a killer's cumulative EXP is filed. Null in every room built without one — see {@link RoomCreateOptions.progressStore}. */
  private progressStore: ProgressStore | null = null;
  private readonly progressSubscriptions = new Map<string, { version: number; unsubscribe?: () => void }>();
  /** Where an account's quest state is filed. Null in every room built without one — see {@link RoomCreateOptions.questStore}. */
  private questStore: QuestStore | null = null;
  /** Where an account's spendable balance is filed. Null in every room built without one — see {@link RoomCreateOptions.currencyStore}. */
  private currencyStore: CurrencyStore | null = null;
  /** Where a quest reward is settled exactly once. Null in every room built without one — see {@link RoomCreateOptions.settlementStore}. */
  private settlementStore: SettlementStore | null = null;
  /**
   * The quests this room can offer: those whose giver NPC stands here. Resolved once at `onCreate`
   * against this room's own object index — the `PortalIndex`/`InteractableIndex` narrowing, for
   * their reason, and it is the boundary `handleAcceptQuest` checks a client's id against.
   */
  private roomQuests!: ReadonlyMap<string, QuestDefinition>;
  /** Death EXP penalty exemptions (design-phase-w-level-system.md §11.0). Empty unless configured. */
  private adminOwnerKeys: ReadonlySet<string> = new Set();
  /** The enforced join cap — {@link RoomCreateOptions.realCapacity}, falling back to `maxClients`. */
  private realCapacity!: number;
  private collisionMap!: CollisionMap;
  private proximityIndex!: ProximityIndex;
  private portalIndex!: PortalIndex;
  /** {@link PortalIndex.requiredItemKeys} of this room, read once at `onCreate` and never rebuilt. */
  private gatedItemKeys!: ReadonlySet<string>;
  private interactableIndex!: InteractableIndex;
  private landmarkIndex!: LandmarkIndex;
  private spawn!: SpawnArea;
  /**
   * Where "return home" lands: the spawn centre with the spawn's spread deliberately dropped.
   *
   * Home has to be one determinate tile — a player who warps twice and lands somewhere else
   * each time has not gone home. That is the opposite of what the spread is for on join, so
   * this cannot just reuse {@link spawn}: grand-plaza spreads over radius 70.
   */
  private home!: SpawnArea;

  async onCreate(options: RoomCreateOptions): Promise<void> {
    this.state = new RoomState();
    this.state.roomType = options.roomType;
    this.state.mapKey = options.mapKey;
    this.maxClients = options.maxClients;
    this.realCapacity = options.realCapacity ?? options.maxClients;
    this.spawn = options.spawn;
    this.home = { tileX: options.spawn.tileX, tileY: options.spawn.tileY, spreadRadiusInTiles: 0 };
    this.landmarkIndex = this.createLandmarkIndex(this.home);
    this.inventoryStore = options.inventoryStore ?? null;
    this.bossStateStore = options.bossStateStore ?? null;
    this.progressStore = options.progressStore ?? null;
    this.questStore = options.questStore ?? null;
    this.currencyStore = options.currencyStore ?? null;
    this.settlementStore = options.settlementStore ?? null;
    this.adminOwnerKeys = options.adminOwnerKeys ?? new Set();
    this.setPatchRate(PATCH_RATE_MS);
    this.maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

    this.collisionMap = await this.mapLoader.load(options.mapKey);
    this.proximityIndex = this.createProximityIndex(this.collisionMap);
    this.portalIndex = this.createPortalIndex(this.collisionMap);
    this.gatedItemKeys = this.portalIndex.requiredItemKeys();
    this.interactableIndex = this.createInteractableIndex(this.collisionMap);
    // Narrowed through the object index rather than by comparing room names: the index is already
    // this room's own view of the object table, so a giver it cannot resolve is a giver that is
    // not here — one rule, and it stays right if the object table is ever narrowed differently.
    this.roomQuests = new Map(
      [...QUESTS_BY_ID].filter(([, quest]) => this.interactableIndex.byId(quest.giverObjectId) !== null),
    );
    // Static for the room's lifetime — populated once here, never touched again. This is the
    // only reason the client learns a portal's position at all (never its id or destination).
    for (const tile of this.portalIndex.triggerTiles()) {
      this.state.portalMarkers.push(new PortalMarker(tile));
    }
    // Position and kind only. An object's content never enters the state — it would be a static
    // broadcast to every client that buys nothing, and it would put the quiz answers on the wire.
    for (const tile of this.interactableIndex.markerTiles()) {
      this.state.interactableMarkers.push(new InteractableMarker(tile));
    }

    await this.populateMonsters();

    this.onMessage(ClientMessage.Move, (client: RoomClient, message: MoveRequest) => {
      this.handleMove(client, message);
    });
    this.onMessage(ClientMessage.Chat, (client: RoomClient, message: ChatRequest) => {
      this.handleChat(client, message);
    });
    this.onMessage(ClientMessage.ReturnHome, (client: RoomClient) => {
      this.handleReturnHome(client);
    });
    this.onMessage(ClientMessage.QuizAnswer, (client: RoomClient, message: QuizAnswerRequest) => {
      this.handleQuizAnswer(client, message);
    });
    this.onMessage(ClientMessage.Attack, (client: RoomClient) => {
      this.handleAttack(client);
    });
    this.onMessage(ClientMessage.EquipItem, (client: RoomClient, message: EquipItemRequest) => {
      this.handleEquipItem(client, message);
    });
    this.onMessage(ClientMessage.UnequipItem, (client: RoomClient, message: UnequipItemRequest) => {
      this.handleUnequipItem(client, message);
    });
    this.onMessage(ClientMessage.ChangeSkin, (client: RoomClient, message: ChangeSkinRequest) => {
      this.handleChangeSkin(client, message);
    });
    this.onMessage(ClientMessage.WarpToLandmark, (client: RoomClient, message: WarpToLandmarkRequest) => {
      this.handleWarpToLandmark(client, message);
    });
    this.onMessage(ClientMessage.AcceptQuest, (client: RoomClient, message: AcceptQuestRequest) => {
      this.handleAcceptQuest(client, message);
    });

    // Last, and only where there is something to simulate. A room with no monster *rows* stays
    // purely message-driven, which is what it was before this feature existed. Colyseus disposes
    // an empty room, so monster state is never persisted either — the last player to leave resets
    // the health of whatever they were fighting, which is the documented specification.
    //
    // Gated on `monsterRuntimes.size`, not `state.monsters.size` (design-phase-i-boss-monster.md
    // §6.4): a boss row can start dead (§2.4) with nothing in `state.monsters` yet, and that must
    // not be mistaken for "this room owns no monsters at all" — the tick loop is what counts its
    // respawn down. Equivalent for every room today (hunting-ground/hunting-den always have a
    // living squirrel/rabbit/deer alongside any dead boss), but this is the check that stays
    // correct if a future room ever holds a boss and nothing else.
    if (this.monsterRuntimes.size > 0) {
      this.setSimulationInterval(() => {
        this.tick(Date.now());
      }, MONSTER_TICK_MS);
    }
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
   * Overridable seam, the monster twin of {@link createProximityIndex}: a test subclass wraps it
   * to prove a room without monsters never queries it — never builds it, in fact, since
   * {@link populateMonsters} only calls this when the room owns at least one spawn row.
   */
  protected createMonsterIndex(map: CollisionMap): ProximityIndex {
    return new UniformGridProximityIndex(
      map.widthInTiles,
      map.heightInTiles,
      PROXIMITY_CELL_SIZE_TILES,
    );
  }

  /**
   * Overridable seam: a test subclass injects a hand-built table instead of the real one.
   *
   * Narrowed by `this.roomName`, exactly as the portal and object indexes are, and with the same
   * consequence — a room whose name is in no row (including a room built without the matchmaker,
   * which is how the view tests build one) simply has no monsters.
   */
  protected monsterSpawns(): readonly MonsterSpawnDefinition[] {
    if (this.roomName === undefined) {
      return [];
    }
    return MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === this.roomName);
  }

  /** Overridable seam, paired with {@link monsterSpawns} so a fixture can bring its own kinds. */
  protected monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return MONSTER_TYPES;
  }

  /**
   * Overridable seam: a test subclass injects a hand-built table instead of the real one.
   *
   * `this.roomName` is the room's matchmaking name, and a name in no row of the table — or the
   * runtime-undefined name of a room built without the matchmaker — yields an index that
   * answers null to everything. That is the normal path for a room with no doors, not an error,
   * so nothing is asserted about it here.
   */
  protected createPortalIndex(map: CollisionMap): PortalIndex {
    return new TablePortalIndex(this.roomName, PORTAL_DEFINITIONS, map);
  }

  /**
   * Overridable seam, for the reason {@link createPortalIndex} gives: a room whose name matches no
   * row — including the runtime-undefined name of a room built without the matchmaker — gets an
   * index that answers null to everything, which is the normal path for a room with no objects.
   */
  protected createInteractableIndex(map: CollisionMap): InteractableIndex {
    return new TableInteractableIndex(this.roomName, INTERACTABLE_DEFINITIONS, map);
  }

  /** Overridable seam, the landmark twin of {@link createPortalIndex}/{@link createInteractableIndex}. */
  protected createLandmarkIndex(home: SpawnArea): LandmarkIndex {
    return new TableLandmarkIndex(this.roomName, LANDMARK_DEFINITIONS, home);
  }

  /**
   * The room's one source of randomness, an overridable seam of the same family as
   * {@link createProximityIndex} and its siblings: a test subclass drops in a seeded generator and
   * gets exact, replayable draws.
   *
   * A seam rather than direct calls to `Math.random`, which is what spawn sampling used to do and
   * what its tests had to swap the global out to control — that interferes with anything else
   * running in the same process, and it leaves "the randomness belonging to this room" written
   * nowhere in the code.
   */
  protected random(): number {
    return Math.random();
  }

  /**
   * Always returns a truthy object — see {@link AuthResult}. Both fields are null outside SSO
   * (local dev, tests): `onJoin` then falls back to `options.nickname`, and drops are credited
   * against the session id instead of an account.
   */
  onAuth(_client: RoomClient, _options: JoinOptions | undefined, context: AuthContext): AuthResult {
    return {
      ssoNickname: deriveSsoNickname(context.headers),
      // Read here rather than inside `deriveSsoUserId`, which takes the token itself because its
      // other caller is an express route holding a different kind of header container.
      ssoUserId: deriveSsoUserId(context.headers.get("x-auth-request-access-token")),
    };
  }

  async onJoin(client: RoomClient, options?: JoinOptions): Promise<void> {
    // `maxClients` no longer bounds hunting-ground/hunting-den — raised past reach so a full room
    // never spins up a second instance (design-phase-i-boss-monster.md §1.2, one boss per zone
    // depends on there only ever being one room instance). The real 40/20 gameplay cap is enforced
    // here instead, the same "throw refuses the whole join" shape the landmark gate below uses.
    if (this.state.players.size >= this.realCapacity) {
      throw new Error(`"${this.roomName}" is full`);
    }

    const nickname = normalizeNickname(client.auth?.ssoNickname ?? options?.nickname);
    if (nickname === null) {
      throw new Error("nickname is required");
    }

    // An id this room does not own — unknown, or one belonging to a door out of this room —
    // falls back to the generic spawn rather than refusing the join, which would strand a
    // client whose portal row changed while its tab was open.
    const viaPortal = typeof options?.viaPortal === "string" ? options.viaPortal : undefined;
    const arrival = viaPortal === undefined ? null : this.portalIndex.arrivalFor(viaPortal);

    // Checked only when no portal arrival won, so an ordinary join, a portal hop or a home hop
    // never pays for this: the lookup below is one Map read, and the store round trip beneath it
    // fires only for the one landmark row that is actually gated (today, only hunting-den's).
    const arriveAtLandmark = typeof options?.arriveAtLandmark === "string" ? options.arriveAtLandmark : undefined;
    let landmarkArrival: SpawnArea | null = null;
    if (arrival === null && arriveAtLandmark !== undefined) {
      const landmark = this.landmarkIndex.resolve(arriveAtLandmark);
      if (landmark !== null) {
        if (landmark.requiresItemKey === undefined || (await this.holdsItem(client, landmark.requiresItemKey))) {
          landmarkArrival = landmark.area;
        } else {
          // Refuses the whole join rather than falling back to this room's plain spawn: a gated
          // landmark is an access-control door exactly like the portal beside it
          // (hunting-ground-north-door), and landing anywhere inside hunting-den without the pass
          // would be exactly the bypass that door exists to prevent (design §2.4).
          throw new Error(`landmark "${arriveAtLandmark}" requires item "${landmark.requiresItemKey}"`);
        }
      }
      // landmark === null: unknown id, or one belonging to a landmark elsewhere — falls through to
      // arriveAtHome/spawn below, the same "unowned id is not a refusal" rule viaPortal follows.
    }

    // Portal beats home: it is the more specific request, and the only one of the two the
    // server itself issued. An unowned portal id falls through to home if home was asked for,
    // not to the spawn — the client asked for two things and only one of them was rejected.
    const area = arrival ?? landmarkArrival ?? (options?.arriveAtHome === true ? this.home : this.spawn);

    // Re-checked immediately before the seat is taken, because the gated-landmark branch above is
    // an await: the check at the top of this method ran before it, so concurrent gated joins would
    // every one of them have seen the same pre-await count and every one of them would have been
    // admitted. hunting-den's 20 is the cap this protects — its landmark is the only gated one, and
    // that landmark is the only way in.
    if (this.state.players.size >= this.realCapacity) {
      throw new Error(`"${this.roomName}" is full`);
    }

    const spawnTile = this.pickSpawnTile(area);
    this.state.players.set(
      client.sessionId,
      new Player({
        nickname,
        tileX: spawnTile.tileX,
        tileY: spawnTile.tileY,
        facing: Direction.Down,
        avatarSkin: normalizeAvatarSkin(options?.avatarSkin),
        // Always 1, never left unset: `hydrateProgressCache` (below) raises this once it learns the
        // account's real level, but that read has not happened yet at the moment this object is
        // constructed, in every room — including grand-plaza, which now hydrates progress the same
        // as any other room (design-phase-w2-level-client.md §1.3) — so every join still needs a
        // defined placeholder here, not the schema's own `undefined` default (design-phase-w-level-
        // system.md, W-2 handoff: a client that has not yet learned to read this field never sees an
        // implausible Lv.0).
        level: 1,
      }),
    );
    this.proximityIndex.insert(client.sessionId, spawnTile);
    client.userData = {
      nickname,
      lastMoveAt: 0,
      lastChatAt: 0,
      lastWarpAt: 0,
      lastAttackAt: 0,
      // Full health on every arrival, including one through a portal: there is no way to heal an
      // injury that outlived the room it happened in, so carrying one across would be a state
      // nothing could undo.
      hp: PLAYER_MAX_HP,
      lastDamagedAt: 0,
      // Hydration supplies the initial value; account subscriptions keep every active session current.
      totalExp: 0,
      ownerKey: client.auth?.ssoUserId ?? null,
      ownedPossessionKeys: new Set(),
      confirmedPossessionKeys: new Set(),
      pendingPossessionGrants: new Map(),
      equippedItemKeys: {},
      equipCacheVersions: initialEquipCacheVersions(),
      equipRequestPendingSlots: new Set(),
      questRows: new Map(),
      // The map above is empty *and* says nothing yet; only the flag distinguishes the two.
      questRowsHydrated: false,
      // hydrateCurrencyCache supplies the real value on join; a settled quest reward updates it live.
      currencyBalance: 0,
    };
    client.view = new StateView();
    this.viewedBySession.set(client.sessionId, new Set());
    this.clientsBySession.set(client.sessionId, client);

    this.refreshViewsAround(client.sessionId, null, spawnTile);
    if (this.hasMonsters) {
      this.monstersViewedBySession.set(client.sessionId, new Set());
      this.refreshMonsterViewFor(client.sessionId);
    }

    // Fire-and-forget, and only where a portal could even ask: a room with no gated door never
    // touches the store on join, which is every room but hunting-ground today.
    //
    // Caught rather than left to the process: an unhandled rejection is fatal under Node's default
    // `--unhandled-rejections=throw`, so a Postgres hiccup here would take the whole server down
    // with it — awardLoot's own rule (design-phase-i-boss-monster.md §2.5). A lost hydration only
    // costs this session its catch-up read; `holdsItem` asks the store directly anyway.
    const ownerKey = client.userData.ownerKey ?? client.sessionId;
    if (this.gatedItemKeys.size > 0 && this.inventoryStore !== null) {
      void this.hydratePossessionCache(client.sessionId, ownerKey).catch((cause) => {
        console.warn(`[zep-test] could not hydrate possessions for ${ownerKey}`, cause);
      });
    }
    // Same reasoning as the possession gate above: equippedItemKeys is only ever read by
    // damagePlayer/handleAttack, neither of which ever runs outside a hasMonsters room, so
    // hydrating it in grand-plaza is a pure-waste DB round trip on the 500 CCU join path (PoC #2).
    // Equip/unequip itself still works in any room — that path writes the cache directly, it
    // never depends on hydration.
    if (this.hasMonsters && this.inventoryStore !== null) {
      void this.hydrateEquipmentCache(client.sessionId, ownerKey).catch((cause) => {
        console.warn(`[zep-test] could not hydrate equipment for ${ownerKey}`, cause);
      });
    }
    // Not gated on `hasMonsters` (unlike the equipment hydration just above): the level shown in
    // `Player.level` is now real in every room, including grand-plaza (design-phase-w2-level-
    // client.md §1.3 — "레벨은 grand-plaza를 포함한 모든 room에서 실제 값이 보여야 한다",
    // `docs/decisions.md` 2026-09-11), so every room with a store hydrates on join. This is not the
    // per-join DB round trip that reasoning used to warn about: `progressStore` is a
    // `CachedProgressStore` in every real deployment (`index.ts`), so a cold miss happens at most
    // once per account for the life of the process — every join after that is a synchronous cache
    // hit, which is what keeps this off the PoC #2 500 CCU join-path budget.
    if (this.progressStore !== null) {
      const binding: { version: number; unsubscribe?: () => void } = { version: 0 };
      this.progressSubscriptions.set(client.sessionId, binding);
      binding.unsubscribe = this.progressStore.subscribe?.(ownerKey, (total, reason) => {
        if (this.progressSubscriptions.get(client.sessionId) !== binding) {
          return;
        }
        binding.version += 1;
        this.updateProgress(client.sessionId, total, reason === "grant");
      });
      void this.hydrateProgressCache(client.sessionId, ownerKey).catch((cause) => {
        console.warn(`[zep-test] could not hydrate progress for ${ownerKey}`, cause);
      });
    }
    // Gated on this room having something to do with a quest at all — a giver standing here, or
    // monsters that could advance one. Everywhere else the cache would only ever be written and
    // never read, which on the 500 CCU join path (PoC #2) is a round trip bought for nothing. It is
    // deliberately *not* gated the way progress is (every room, always): unlike `Player.level`,
    // quest state is shown by a panel that only exists where the giver is.
    const questHydration =
      this.questStore !== null && (this.hasMonsters || this.roomQuests.size > 0)
        ? this.hydrateQuestCache(client.sessionId, ownerKey).catch((cause) => {
            console.warn(`[zep-test] could not hydrate quests for ${ownerKey}`, cause);
          })
        : null;
    // Not gated on `hasMonsters`/`roomQuests`, `hydrateProgressCache`'s own reasoning: the bag
    // window that shows this balance is open to every room, not only the ones with a quest giver
    // or a fight in them.
    //
    // Chained *after* the quest hydration rather than fired beside it, because that hydration can
    // pay out D6's retry for an account whose completion never settled — and this is the only
    // message that announces the result of one (`settleQuestReward`'s `notify: false` deliberately
    // stays silent there). Run in parallel the two are not merely racy but reliably wrong in that
    // case: this read is one hop, the retry is at least two (`list`, then `settle`'s whole
    // transaction), so the balance announced would be the pre-settlement one every time, and would
    // stay wrong until the next join. The retry's own `SettlementOutcome.balance` is deliberately
    // not used instead — for an already-settled account `settle` replays the balance recorded at
    // settlement time, which stops being the current one the moment D4/D5 give currency a second
    // way to move. This reads the account's actual balance, after everything that could change it.
    if (this.currencyStore !== null) {
      void (questHydration ?? Promise.resolve())
        .then(() => this.hydrateCurrencyCache(client.sessionId, ownerKey))
        .catch((cause) => {
          console.warn(`[zep-test] could not hydrate currency for ${ownerKey}`, cause);
        });
    }
  }

  /**
   * On-demand possession check for a gated landmark. Not `session.ownedPossessionKeys`: that
   * cache is only ever populated by `hydratePossessionCache`, which runs only in a room whose own
   * *outgoing* portal is gated (`gatedItemKeys.size > 0`) — hunting-den has none, so a client
   * landmark-warping straight into it would find that cache permanently, silently empty regardless
   * of what it actually holds. A join is a low-frequency, human-triggered action, so one extra
   * round trip here costs nothing the hot move path would notice.
   */
  private async holdsItem(client: RoomClient, itemKey: string): Promise<boolean> {
    if (this.inventoryStore === null) {
      // Same fail-closed rule handleMove's own portal gate already applies with no store
      // configured — an unconfigured store can prove nothing is owned, so nothing gated ever
      // gets through.
      return false;
    }
    const ownerKey = client.auth?.ssoUserId ?? client.sessionId;
    const rows = await this.inventoryStore.list(ownerKey);
    return rows.some((row) => row.itemKey === itemKey);
  }

  /**
   * Fills a freshly joined session's {@link PlayerSession.ownedPossessionKeys} from the store, so
   * a portal gate check right after join does not have to wait on one — this is the one-time catch
   * -up read for a possession item granted in an earlier room visit; a same-session grant during
   * this visit is added to the set directly by {@link awardLoot} instead.
   *
   * Never awaited by its caller, for `awardLoot`'s reason: the room must not stall while the store
   * answers, and the session may have disconnected by the time it does.
   */
  private async hydratePossessionCache(sessionId: string, ownerKey: string): Promise<void> {
    const store = this.inventoryStore;
    if (store === null) {
      return;
    }
    const rows = await store.list(ownerKey);
    // Re-resolved after the await, exactly as `awardLoot` does: the session may have left the
    // room while the store was answering.
    const session = this.clientsBySession.get(sessionId)?.userData;
    if (!session) {
      return;
    }
    for (const row of rows) {
      if (this.gatedItemKeys.has(row.itemKey)) {
        session.ownedPossessionKeys.add(row.itemKey);
        session.confirmedPossessionKeys.add(row.itemKey);
      }
    }
  }

  /**
   * Fills a freshly joined session's {@link PlayerSession.equippedItemKeys} from the store, all
   * eight slots in one round trip (`getEquippedSlots`, design §3, §4.3) — the one-time catch-up
   * read for whatever was equipped in an earlier room visit. Never awaited by its caller, for
   * {@link hydratePossessionCache}'s reason.
   *
   * Guarded by `equipCacheVersions`, per slot, rather than only by the session still existing: an
   * equip or unequip request issued right after join can resolve before this read does, and that
   * request is the newer, more specific action for *its* slot — this stale answer must not
   * overwrite it. Comparing per slot rather than as one shared version is what lets a request on
   * one slot win while this hydration still applies its answer to every other slot normally
   * (design §4.2) — a shared counter would have let that request's resolution invalidate the
   * other seven slots' hydration too, for no reason at all.
   */
  private async hydrateEquipmentCache(sessionId: string, ownerKey: string): Promise<void> {
    const store = this.inventoryStore;
    if (store === null) {
      return;
    }
    const session = this.clientsBySession.get(sessionId)?.userData;
    if (!session) {
      return;
    }
    const versionsAtStart = { ...session.equipCacheVersions };
    const equipped = await store.getEquippedSlots(ownerKey);
    const current = this.clientsBySession.get(sessionId)?.userData;
    if (!current) {
      return;
    }
    for (const slot of EQUIPMENT_SLOTS) {
      if (current.equipCacheVersions[slot] !== versionsAtStart[slot]) {
        // A newer write for this slot already landed; its answer stands, same as `handleEquip
        // Item`'s own compare.
        continue;
      }
      const itemKey = equipped[slot];
      // Bumped only when this actually changes the cache — matching `equipCacheVersions`'s own
      // doc comment ("bumped by every write that actually changes the cache") literally, rather
      // than unconditionally on every hydration: an unconditional bump would let a same-answer
      // hydration (the common case — nothing has happened between join and this read resolving)
      // invalidate a same-slot equip/unequip request that is still in flight for no reason at all,
      // since that request's own `versionAtStart` was captured before this hydration started.
      if (current.equippedItemKeys[slot] !== itemKey) {
        if (itemKey === undefined) {
          delete current.equippedItemKeys[slot];
        } else {
          current.equippedItemKeys[slot] = itemKey;
        }
        current.equipCacheVersions[slot] += 1;
      }
    }
  }

  /**
   * Fills a freshly joined session's {@link PlayerSession.totalExp} from the store, and raises
   * the public `Player.level` schema field to match — the progress twin of
   * {@link hydrateEquipmentCache}, but gated only on `progressStore !== null`
   * (design-phase-w2-level-client.md §1.3): every room, grand-plaza included, reaches this call, so
   * every room's join path touches `player_progress` — at most once per account for the life of the
   * process, since `progressStore` is a `CachedProgressStore` (`index.ts`) and every join after the
   * first cold miss never leaves that wrapper's own synchronous `Map.get`.
   *
   * Never awaited by its caller. A subscription version rejects snapshots overtaken by either
   * a grant or a penalty, including a newer total that is smaller than the snapshot.
   */
  private async hydrateProgressCache(sessionId: string, ownerKey: string): Promise<void> {
    const store = this.progressStore;
    if (store === null) {
      return;
    }
    const binding = this.progressSubscriptions.get(sessionId);
    const version = binding?.version;
    const exp = await store.getExp(ownerKey);
    if (this.progressSubscriptions.get(sessionId) !== binding || binding?.version !== version) {
      return;
    }
    const current = this.clientsBySession.get(sessionId)?.userData;
    const player = this.state.players.get(sessionId);
    if (!current || !player || exp === null || exp <= current.totalExp) {
      return;
    }
    this.updateProgress(sessionId, exp, false);
  }

  /**
   * Fills a freshly joined session's {@link PlayerSession.currencyBalance} from the store and
   * pushes it to the client as a {@link ServerMessage.CurrencyChanged} with `reason: "sync"`
   * (roadmap R04-b) — currency's own initial-sync path, needed because unlike `Player.level` a
   * balance is never in `RoomState` (nobody but the owner needs to see it) and unlike the bag it is
   * not read back over HTTP either, so without this a joining client has nothing to show until its
   * first grant.
   *
   * Gated only on `currencyStore !== null`, `hydrateProgressCache`'s own reasoning: every room
   * shows the bag, so every room's join path touches `player_currency`.
   *
   * Never awaited by its caller, `hydratePossessionCache`'s rule. No subscription unlike EXP —
   * see {@link PlayerSession.currencyBalance}'s own doc comment for why that gap is tolerated here.
   */
  private async hydrateCurrencyCache(sessionId: string, ownerKey: string): Promise<void> {
    const store = this.currencyStore;
    if (store === null) {
      return;
    }
    const balance = await store.getBalance(ownerKey);
    // Re-resolved after the await, exactly as every other hydration here does: the session may
    // have left the room, or walked into another one, while the store was answering.
    const client = this.clientsBySession.get(sessionId);
    const session = client?.userData;
    if (!client || !session) {
      return;
    }
    session.currencyBalance = balance;
    client.send(ServerMessage.CurrencyChanged, {
      balance,
      delta: 0,
      reason: "sync",
    } satisfies CurrencyChanged);
  }

  /**
   * Fills a freshly joined session's {@link PlayerSession.questRows} from the store and tells the
   * client what it found, one {@link ServerMessage.QuestUpdated} per accepted quest — the quest
   * twin of {@link hydrateProgressCache}. This is what "재접속 후 진행 유지" is on the wire: the
   * counter survives in the database on its own, and this is how a client learns it again.
   *
   * Messages are sent even for a quest whose giver is in another room: the account's progress is
   * the account's wherever it is standing, and a client tracker that only knew about the quests of
   * whatever room it happened to join would blink its own list on every door.
   *
   * Never awaited by its caller, `hydratePossessionCache`'s rule, and it merges through
   * {@link rememberQuestRow} rather than overwriting: an accept or a kill can commit inside the
   * hydration window, which would make this list — issued earlier, answered later — the *older*
   * truth of the two. Overwriting with it would walk the counter backwards and lose a credit the
   * database already holds.
   */
  private async hydrateQuestCache(sessionId: string, ownerKey: string): Promise<void> {
    const store = this.questStore;
    if (store === null) {
      return;
    }
    const rows = await store.list(ownerKey);
    // Re-resolved after the await, exactly as every other hydration here does: the session may
    // have left the room, or walked into another one, while the store was answering.
    const client = this.clientsBySession.get(sessionId);
    const session = client?.userData;
    if (!client || !session) {
      return;
    }
    for (const row of rows) {
      this.rememberQuestRow(session, row);
    }
    // Set after the merge, never before: until this line the map is only "what this session has
    // done", and the kill path must keep asking the store. Set even when the account has accepted
    // nothing — an empty map plus this flag is the answer "none", which is what lets the kill path
    // stop consulting the store at all.
    session.questRowsHydrated = true;
    // Awaited before this method resolves (below) rather than left to run loose: `onJoin` chains
    // the join-time currency sync onto this promise, and that sync is what announces whatever the
    // retries below pay out.
    const retries: Promise<void>[] = [];
    for (const row of rows) {
      const quest = QUESTS_BY_ID.get(row.questId);
      // A stored row whose quest has since been removed from the table: nothing to render, and
      // nothing to be done about it here — the row stays for an author who puts the quest back.
      if (quest === undefined) {
        continue;
      }
      client.send(ServerMessage.QuestUpdated, questState(quest, row));
      if (row.completed && quest.reward !== undefined) {
        // D6's own retry: the completion that produced this row may have called `settleQuestReward`
        // and lost the race (the process died, or the session left, between `store.recordKill`
        // committing and that call's own `await` landing) — retried here, on every join, because
        // `settle()`'s ledger (design §4 D2) makes an already-settled retry a free no-op rather than
        // a second credit. `session.ownerKey` rather than the `ownerKey` parameter: the latter falls
        // back to the session id for local development, which `settleQuestReward` must never be
        // handed (see its own doc comment).
        retries.push(
          this.settleQuestReward(sessionId, session.ownerKey, quest.id, quest.reward.currencyDelta, false),
        );
      }
    }
    // `settleQuestReward` never rejects (it logs and returns), so this cannot turn a paid-out
    // retry into a failed hydration — it only holds the currency sync until the ledger is settled.
    await Promise.all(retries);
  }

  private updateProgress(sessionId: string, total: number, healOnLevelUp: boolean): void {
    const session = this.clientsBySession.get(sessionId)?.userData;
    const player = this.state.players.get(sessionId);
    if (!session || !player) {
      return;
    }
    const oldLevel = levelForExp(session.totalExp);
    const oldMaxHp = this.totalMaxHp(session);
    session.totalExp = total;
    player.level = levelForExp(total);
    const newMaxHp = this.totalMaxHp(session);
    session.hp = healOnLevelUp && player.level > oldLevel
      ? newMaxHp
      : Math.min(newMaxHp, session.hp + newMaxHp - oldMaxHp);
  }

  onLeave(client: RoomClient): void {
    this.progressSubscriptions.get(client.sessionId)?.unsubscribe?.();
    this.progressSubscriptions.delete(client.sessionId);
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
    // Not gated on `hasMonsters`: a delete against an empty Map is cheaper than the branch, and
    // leaving this behind would leak a Set per session for the room's whole life.
    this.monstersViewedBySession.delete(client.sessionId);
    this.clientsBySession.delete(client.sessionId);
    this.moveThrottleNotified.delete(client.sessionId);
    // Disconnecting mid-fight leaves a boss fight exactly as a death does, and by the same
    // judgement (design §6.6) — see {@link leaveBossCombat}, which both paths share.
    // `monsterRuntimes` is empty in a room with no monsters, so this costs nothing there.
    this.leaveBossCombat(client.sessionId, Date.now());
  }

  onDispose(): void {
    for (const binding of this.progressSubscriptions.values()) {
      binding.unsubscribe?.();
    }
    this.progressSubscriptions.clear();
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
    // The mover's own origin shifted, so its monster view has to be recomputed too — the same
    // reason `refreshViewsAround` finishes by recomputing its player view. The guard, not a
    // branch inside the shared code, is what keeps a monsterless room on its old path.
    if (this.hasMonsters) {
      this.refreshMonsterViewFor(client.sessionId);
    }

    // Last, strictly after the index and view bookkeeping above: a throw on this path must not
    // leave that bookkeeping half-applied, which is the failure that makes a player permanently
    // invisible (or permanently visible) to their neighbours.
    const portal = this.portalIndex.triggerAt(destination.tileX, destination.tileY);
    if (portal !== null) {
      if (portal.requiresItemKey !== undefined && !session.ownedPossessionKeys.has(portal.requiresItemKey)) {
        // The tile stays exactly as walkable as it was — no collision changes, the player just
        // does not transition. The `!` is safe: boot validation refuses a `requiresItemKey`
        // without a `deniedMessage`.
        client.send(ServerMessage.PortalDenied, {
          portalId: portal.id,
          message: portal.deniedMessage!,
        } satisfies PortalDenied);
      } else {
        client.send(ServerMessage.PortalEntered, {
          portalId: portal.id,
          toRoom: portal.to.room,
        } satisfies PortalEntered);
      }
    }

    // Behind the portal check for readability only: boot refuses a table that puts an object on a
    // portal trigger, so at most one of the two can ever fire on the same step.
    const object = this.interactableIndex.at(destination.tileX, destination.tileY);
    if (object !== null) {
      client.send(
        ServerMessage.InteractableEntered,
        toInteraction(object, this.questsOffered(session, object.id)),
      );
    }
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
   * Puts the player back on the room's home tile. The only non-adjacent position change the
   * room performs, which is what makes the two invariants below load-bearing rather than latent.
   */
  private handleReturnHome(client: RoomClient): void {
    const session = client.userData;
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) {
      return;
    }

    const now = Date.now();
    if (now - session.lastWarpAt < HOME_COOLDOWN_MS) {
      // Dropped in silence, unlike a throttled move: the client mirrors this window as the
      // button's disabled period, so anything arriving inside it is a duplicate rather than a
      // misprediction to correct — and the player is already standing where it would send them.
      return;
    }
    session.lastWarpAt = now;

    this.warpTo(client, player, this.home);
  }

  /**
   * One same-room landmark warp. The cross-room half of the landmark panel rejoins via
   * `JoinOptions.arriveAtLandmark` instead ({@link onJoin}) — this handler only ever fires when
   * the client is already in the room the chosen landmark belongs to.
   */
  private handleWarpToLandmark(client: RoomClient, message: WarpToLandmarkRequest): void {
    const session = client.userData;
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) {
      return;
    }
    const now = Date.now();
    if (now - session.lastWarpAt < HOME_COOLDOWN_MS) {
      return;
    }
    const landmarkId = message?.landmarkId;
    if (typeof landmarkId !== "string") {
      return;
    }
    const landmark = this.landmarkIndex.resolve(landmarkId);
    if (landmark === null) {
      return;
    }
    session.lastWarpAt = now;
    this.warpTo(client, player, landmark.area);
  }

  /**
   * Puts one player on `destinationArea` and tells them so.
   *
   * Shared by the return-home request, the same-room landmark warp and by death, which are all
   * the same movement reached from a different place ({@link handleReturnHome},
   * {@link handleWarpToLandmark}, {@link damagePlayer}). One copy rather than several on purpose:
   * the ordering below is load-bearing and invisible, so a second copy of it is a second chance to
   * get it wrong somewhere nobody is looking. The cooldown is the caller's business, not this
   * one's — death does not consult it.
   */
  private warpTo(client: RoomClient, player: Player, destinationArea: SpawnArea): void {
    const destination = this.pickSpawnTile(destinationArea);
    const from = { tileX: player.tileX, tileY: player.tileY };
    player.tileX = destination.tileX;
    player.tileY = destination.tileY;
    // Same convention as the first placement in onJoin: an arrival has no direction of travel
    // to inherit, and keeping the pre-warp facing would point the avatar back at a tile it is
    // no longer next to.
    player.facing = Direction.Down;
    // Index strictly before the view refresh. handleMove says a one-tile step masks the
    // ordering; this is the path it warned about — `from` is normally outside the destination's
    // view radius, so a stale index entry drops the warper out of their own rebuilt view.
    this.proximityIndex.move(client.sessionId, destination);
    this.refreshViewsAround(client.sessionId, from, destination);
    if (this.hasMonsters) {
      this.refreshMonsterViewFor(client.sessionId);
    }

    // Sent even though the state patch carries the same position: a client with steps in
    // flight ignores its own position patches, so a warp landing mid-walk would be swallowed.
    client.send(ServerMessage.Teleported, {
      tileX: destination.tileX,
      tileY: destination.tileY,
      facing: Direction.Down,
    } satisfies Teleported);
  }

  /**
   * Grades one quiz answer and remembers nothing: no score, no attempt count, no interaction
   * state to clean up if the client vanishes mid-question.
   *
   * Deliberately does not check that the player is standing on the object's tile. Nothing is
   * scored, so there is no advantage to deny, and the check would create a failure mode of its
   * own — an answer sent as the player steps off the tile would vanish in silence. The
   * room-narrowed index is already the boundary that stops an id from another room resolving.
   *
   * Deliberately has no rate limit of its own either. Chat needed one because it fans out O(k),
   * and the home warp because it queries O(room population); this is one `Map` lookup and one
   * unicast, the same grade as a MoveRejected, and `maxMessagesPerSecond` already caps it.
   */
  private handleQuizAnswer(client: RoomClient, message: QuizAnswerRequest): void {
    const player = this.state.players.get(client.sessionId);
    if (!client.userData || !player) {
      return;
    }

    const objectId = message?.objectId;
    if (typeof objectId !== "string") {
      return;
    }
    // Null for an unknown id or one belonging to another room's object; a non-quiz object is a
    // client asking a signboard for a verdict. Neither has anything useful to be told.
    const object = this.interactableIndex.byId(objectId);
    if (object === null || object.kind !== InteractableKind.Quiz) {
      return;
    }

    const { choiceIndex } = message;
    if (typeof choiceIndex !== "number" || !Number.isInteger(choiceIndex)) {
      return;
    }

    // An out-of-range index is graded wrong rather than ignored: unlike a malformed payload, it
    // came from a client that is waiting for a verdict, and silence would strand its panel.
    client.send(ServerMessage.QuizResult, {
      objectId: object.id,
      choiceIndex,
      correct: choiceIndex === object.answerIndex,
      explanation: object.explanation,
    } satisfies QuizResult);
  }

  /**
   * Accepts a quest offered by an NPC standing in this room (roadmap R03).
   *
   * Room-narrowed the way {@link handleQuizAnswer} is, and here that boundary is load-bearing
   * rather than tidy: this message writes a row. What it bounds is which quests a client can open a
   * row for — never how many rows, since `QuestStore.accept` is an upsert, so a client spamming
   * this buys repeated round trips (capped by `maxMessagesPerSecond`) and exactly one row.
   *
   * No position check, for {@link QuizAnswerRequest}'s stated reason — the room keeps no interaction
   * state to check against. The exposure that buys is bounded by what this message itself can do: it
   * only ever writes an upserted counter row, never a payout — a completion now does pay out
   * (roadmap R04-b), but that happens on the kill that flips `completed`
   * ({@link recordQuestKill}/{@link settleQuestReward}), through a ledger keyed to one account and
   * one quest, so spamming an accept this handler already bounds to one row per quest buys nothing
   * against it either.
   *
   * Ignored in silence with no store configured: there would be nothing to remember the acceptance
   * with, and a client told "accepted" by a room that forgets it the moment it answers has been
   * told something false.
   */
  private handleAcceptQuest(client: RoomClient, message: AcceptQuestRequest): void {
    const store = this.questStore;
    if (!client.userData || !this.state.players.has(client.sessionId) || store === null) {
      return;
    }
    const questId = message?.questId;
    if (typeof questId !== "string") {
      return;
    }
    const quest = this.roomQuests.get(questId);
    if (quest === undefined) {
      return;
    }
    void this.acceptQuest(client.sessionId, quest, store);
  }

  /**
   * The store half of {@link handleAcceptQuest}. Async and never awaited, `awardLoot`'s rule: a
   * database round trip on a message handler would hold the whole room.
   */
  private async acceptQuest(
    sessionId: string,
    quest: QuestDefinition,
    store: QuestStore,
  ): Promise<void> {
    const ownerKey = this.clientsBySession.get(sessionId)?.userData?.ownerKey ?? sessionId;
    let row: QuestRow;
    try {
      row = await store.accept(ownerKey, quest.id);
    } catch (cause) {
      console.warn(`[zep-test] could not accept ${quest.id} for ${ownerKey}`, cause);
      return;
    }
    // Re-resolved after the await, every other store continuation's rule: the acceptance belongs to
    // the account and stands whether or not this session is still here to be told about it.
    const client = this.clientsBySession.get(sessionId);
    if (!client?.userData) {
      return;
    }
    this.rememberQuestRow(client.userData, row);
    client.send(ServerMessage.QuestUpdated, questState(quest, row));
  }

  /**
   * Credits one kill against every quest that targets this monster kind. Last-hit, `awardExp`'s own
   * rule and the same `lastHit` it is handed.
   *
   * The cache is consulted first only to *skip* work: a hydrated session that has not accepted a
   * quest, or has already finished it, has nothing the store could add. When the cache says
   * anything else — including "not hydrated yet" and "this session has already left the room" — the
   * store is asked, because `recordKill` is a no-op for a row that is not there and a wrong guess
   * the other way silently drops a kill the player made.
   */
  private advanceQuests(lastHit: LastHit, kind: MonsterKind): void {
    const store = this.questStore;
    if (store === null) {
      return;
    }
    const quests = QUESTS_BY_MONSTER_KIND.get(kind);
    if (quests === undefined) {
      // The common case for three of the four kinds today: no quest wants this, so no kill of it
      // ever reaches the store.
      return;
    }
    const session = this.clientsBySession.get(lastHit.sessionId)?.userData;
    for (const quest of quests) {
      // Only a hydrated cache may answer "no" — see `PlayerSession.questRowsHydrated`. A session
      // that has already left the room cannot answer at all, and its account still earned the kill.
      if (session?.questRowsHydrated === true) {
        const row = session.questRows.get(quest.id);
        if (row === undefined || row.completed) {
          continue;
        }
      }
      void this.recordQuestKill(lastHit, quest, store);
    }
  }

  /** The store half of {@link advanceQuests}. Async and never awaited, for `awardExp`'s reason. */
  private async recordQuestKill(
    lastHit: LastHit,
    quest: QuestDefinition,
    store: QuestStore,
  ): Promise<void> {
    const ownerKey = lastHit.ownerKey ?? lastHit.sessionId;
    let row: QuestRow | null;
    try {
      row = await store.recordKill(ownerKey, quest.id, quest.objective.count);
    } catch (cause) {
      console.warn(`[zep-test] could not credit a ${quest.id} kill to ${ownerKey}`, cause);
      return;
    }
    if (row === null) {
      // Not accepted, or already completed — the store's answer, and the only place that question
      // is ever really settled. Nothing to say: the client's panel already reads the same way.
      return;
    }
    if (row.completed && quest.reward !== undefined) {
      // The completion transition itself: `recordKill` only ever answers non-null *and*
      // `completed` together on the one call that actually flips it — a later kill of an
      // already-completed quest answers `null` above instead (its own contract,
      // `questStore.ts`'s doc comment) — so this is exactly the moment design §4 D6 settles the
      // reward. Fired whether or not the killer is still here, `awardLoot`'s own rule: a grant
      // belongs to the account, and `hydrateQuestCache`'s retry is what covers the case where this
      // very call is lost before it gets here.
      void this.settleQuestReward(lastHit.sessionId, lastHit.ownerKey, quest.id, quest.reward.currencyDelta, true);
    }
    const client = this.clientsBySession.get(lastHit.sessionId);
    if (!client?.userData) {
      return;
    }
    this.rememberQuestRow(client.userData, row);
    client.send(ServerMessage.QuestUpdated, questState(quest, row));
  }

  /**
   * Settles one quest's {@link QuestDefinition.reward} for the account that just completed it
   * (design §4 D6/D7) — called once from the kill that flips `QuestRow.completed`
   * ({@link recordQuestKill}, `notify: true`) and, in case that call never got this far, again from
   * every later join that still sees the row as completed ({@link hydrateQuestCache},
   * `notify: false`). Both call sites can overlap or repeat freely: `settle()`'s own ledger
   * (`grantKey = "quest:<questId>:<owner>"`, design §4 D2) makes a second attempt for the same
   * account and quest a no-op replay, never a second credit.
   *
   * `ownerKey === null` — no SSO, so no real account — is skipped outright rather than falling
   * back to the session id the way loot/EXP/quest-progress do: `SettlementStore.settle`'s own
   * `assertUuidOwnerKey` (`settlementStore.ts`) rejects anything that is not a uuid, and a session
   * id never is one. Local development therefore completes quests exactly as it did before this
   * Phase — the counter advances, nothing pays out.
   *
   * `notify` is false for the join-time retry on purpose: that call exists to make sure the ledger
   * has a row at all, not to announce one. Sending a `CurrencyChanged` there would either
   * re-announce a grant the original kill already celebrated, or announce one to a killer who had
   * already left when it was earned — `hydrateCurrencyCache`'s own join-time `"sync"` message is
   * what shows the corrected balance instead. That message is chained after this retry rather than
   * sent beside it (`onJoin`'s own reasoning), so "instead" means on this same join, not the next
   * one: fired in parallel, the one-hop balance read always won and announced the pre-settlement
   * balance.
   */
  private async settleQuestReward(
    sessionId: string,
    ownerKey: string | null,
    questId: string,
    currencyDelta: number,
    notify: boolean,
  ): Promise<void> {
    const store = this.settlementStore;
    if (store === null || ownerKey === null) {
      return;
    }
    let outcome: SettlementOutcome;
    try {
      outcome = await store.settle(`quest:${questId}:${ownerKey}`, ownerKey, { currencyDelta });
    } catch (cause) {
      console.warn(`[zep-test] could not settle ${questId}'s reward for ${ownerKey}`, cause);
      return;
    }
    if (!notify || !outcome.ok || outcome.balance === undefined) {
      // `ok: false` only ever means insufficient balance for a currency-only credit like this one
      // (never a full bag, since no reward here ever names an item) — and a positive
      // `currencyDelta` credited onto a balance that can only ever be non-negative can never be
      // declined for that, so this is unreachable with today's authored rewards. `balance ===
      // undefined` is equally unreachable, since this call always sends a non-zero
      // `currencyDelta`. Neither has anything to announce either way.
      return;
    }
    // Re-resolved after the await, exactly as every other store continuation here does: the killer
    // may have left the room, or walked through a door into another one, while the store answered.
    const client = this.clientsBySession.get(sessionId);
    const session = client?.userData;
    if (!client || !session) {
      return;
    }
    session.currencyBalance = outcome.balance;
    client.send(ServerMessage.CurrencyChanged, {
      balance: outcome.balance,
      delta: currencyDelta,
      reason: "quest",
    } satisfies CurrencyChanged);
  }

  /**
   * Writes a store answer into the session cache, keeping it monotonic: a counter only rises and a
   * completion is never undone, so an answer that arrives out of order — a join-time `list` issued
   * before an accept that committed first, two kills whose promises settle in the opposite order —
   * is discarded rather than allowed to walk the cache backwards.
   *
   * Only the cache. The database is already right in every one of those orderings: each write is a
   * single statement against the live row.
   */
  private rememberQuestRow(session: PlayerSession, row: QuestRow): void {
    const known = session.questRows.get(row.questId);
    if (known === undefined || row.killCount > known.killCount || (row.completed && !known.completed)) {
      session.questRows.set(row.questId, row);
    }
  }

  /**
   * What this NPC has to offer the reader, or undefined for an object that gives no quests — which
   * is every row but the plaza guide today.
   *
   * Reads the session cache and never the store: this runs on the move path, immediately behind the
   * object lookup, and a round trip there would hold the room on a step. The cost of that is a
   * panel opened inside the join-hydration window showing an already-accepted quest as `Offered`;
   * accepting it again is idempotent and its answer corrects the panel, so the worst case is one
   * redundant round trip, not a reset counter.
   */
  private questsOffered(
    session: PlayerSession,
    objectId: string,
  ): readonly QuestState[] | undefined {
    const quests = QUESTS_BY_GIVER.get(objectId);
    return quests?.map((quest) => questState(quest, session.questRows.get(quest.id) ?? null));
  }

  /**
   * `PLAYER_ATTACK_DAMAGE` plus this session's level bonus plus every equipped item's
   * `stats.attackDamage`, summed across whichever slots happen to carry that axis (design
   * -phase-w-level-system.md §4.2; equipment axis is design-phase-v-equipment-system.md §5.1,
   * §5.5 — today only the weapon slot's `old-dagger`, but the loop costs nothing extra the day a
   * ring picks up the same axis). Looked up by key on every swing rather than cached,
   * `damagePlayer`'s own reasoning: `ITEM_DEFINITIONS` is a handful of rows and `equippedItemKeys`
   * is the hot value. `level = 1` (no EXP hydrated yet, or none ever granted) makes this exactly
   * `PLAYER_ATTACK_DAMAGE + equipment` — today's value, unchanged — which is the anchor invariant
   * §4.2 requires.
   */
  private totalAttack(session: PlayerSession): number {
    const level = levelForExp(session.totalExp);
    let bonus = 0;
    for (const slot of EQUIPMENT_SLOTS) {
      const itemKey = session.equippedItemKeys[slot];
      if (itemKey === undefined) {
        continue;
      }
      const definition = ITEM_DEFINITIONS.find((item) => item.key === itemKey);
      bonus += definition?.equipment?.stats.attackDamage ?? 0;
    }
    return PLAYER_ATTACK_DAMAGE + (level - 1) * ATTACK_PER_LEVEL + bonus;
  }

  /**
   * `PLAYER_MAX_HP` plus this session's level bonus plus every equipped item's `stats.maxHp`
   * (design-phase-w-level-system.md §4.2). The `maxHp` axis is `totalAttack`'s `attackDamage`
   * twin, and its first real consumer: `ItemDefinition.equipment.stats.maxHp` has been declared
   * since Phase V (`contracts.ts`) but nothing read it before this Phase — no catalogue row sets
   * it today, so this loop currently always adds 0, exactly as `totalAttack`'s did before Phase V
   * shipped `old-dagger`.
   */
  private totalMaxHp(session: PlayerSession): number {
    const level = levelForExp(session.totalExp);
    let bonus = 0;
    for (const slot of EQUIPMENT_SLOTS) {
      const itemKey = session.equippedItemKeys[slot];
      if (itemKey === undefined) {
        continue;
      }
      const definition = ITEM_DEFINITIONS.find((item) => item.key === itemKey);
      bonus += definition?.equipment?.stats.maxHp ?? 0;
    }
    return PLAYER_MAX_HP + (level - 1) * HP_PER_LEVEL + bonus;
  }

  /**
   * One swing. The client names no target: the server picks what the blow lands on from the
   * attacker's own position and facing, so a monster that is not there cannot be named.
   *
   * A swing that reaches nothing is answered with silence — there is no predicted position to
   * correct, unlike a refused move, and the client's animation is its own business.
   */
  private handleAttack(client: RoomClient): void {
    const session = client.userData;
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) {
      return;
    }
    // A room with no monsters never built a monster index, so there is nothing here to swing at
    // and nothing to rate-limit either: the whole handler is one branch on grand-plaza.
    if (!this.hasMonsters) {
      return;
    }

    const now = Date.now();
    if (now - session.lastAttackAt < ATTACK_COOLDOWN_MS) {
      // Dropped in silence, as a return-home inside its cooldown is, and for the same reason: the
      // client mirrors this window as its own input gate, so anything arriving inside it is a
      // duplicate rather than a misprediction to correct.
      return;
    }
    // Stamped before the target search, so a miss costs the cooldown too. Otherwise a client
    // swinging at thin air would buy `maxMessagesPerSecond` proximity queries a second.
    session.lastAttackAt = now;

    const monsterId = this.pickAttackTarget(player);
    if (monsterId === null) {
      return;
    }
    const runtime = this.monsterRuntimes.get(monsterId);
    const monster = this.state.monsters.get(monsterId);
    if (!runtime || !monster) {
      return;
    }

    const damage = this.totalAttack(session);
    runtime.hp -= damage;
    // Overwritten on every hit, not only the killing one: the last person to connect is who the
    // drops belong to, and holding the account as well as the session is what makes the grant
    // survive them walking out of the room before it lands.
    const lastHit: LastHit = { sessionId: client.sessionId, ownerKey: session.ownerKey };
    runtime.lastHitBy = lastHit;
    this.addBossCombatant(runtime, client.sessionId);

    const hpRemaining = Math.max(0, runtime.hp);
    const hit: MonsterHit = {
      monsterId,
      bySessionId: client.sessionId,
      damage,
      hpRemaining,
      hpMax: runtime.type.maxHp,
    };
    // Anchored on the monster and measured with VIEW_RADIUS_TILES, not CHAT_RADIUS_TILES: a bar
    // has to be watchable for as long as the monster is on screen, and a hit on a monster outside
    // the viewer's radius is an event about an entity their client has never been told exists.
    // Sent before the kill below, so the audience is read while the monster is still on the map.
    for (const sessionId of this.proximityIndex.within(monster, VIEW_RADIUS_TILES, this.hitAudienceBuffer)) {
      this.clientsBySession.get(sessionId)?.send(ServerMessage.MonsterHit, hit);
    }

    if (hpRemaining > 0) {
      return;
    }
    this.killMonster(monsterId, now);
    const grants = rollLoot(runtime.type.loot, () => this.random());
    // Deliberately not awaited, here or anywhere the tick can reach: a database round trip that
    // holds this handler holds the whole room, and the wire has already said everything it can
    // say truthfully — `ItemGranted` is the one message that has to wait for the store.
    void this.awardLoot(lastHit, grants);
    // Same fire-and-forget principle, same last-hit rule (design-phase-w-level-system.md §11-5).
    void this.awardExp(lastHit, monsterId, runtime.type.expReward, now);
    // And again for quest objectives (roadmap R03). Synchronous itself — it only decides which
    // quests this kill could possibly touch — and each store call it starts is its own
    // fire-and-forget, for the two calls above's reason.
    this.advanceQuests(lastHit, runtime.type.kind);
  }

  /**
   * What a swing lands on: the living monster within ATTACK_RANGE_TILES that the attacker is
   * facing, else the nearest one, ties broken by monster id. Null when the swing reaches nothing.
   *
   * The tie-break is not cosmetic — two monsters sharing a tile is reachable (they do not block
   * each other any more than they block players), and an order that came out of a hash map would
   * make the same fight play out differently on two runs and untestably on either.
   */
  private pickAttackTarget(player: Player): string | null {
    const step = STEP_BY_DIRECTION[player.facing as Direction];
    const facedX = player.tileX + step.dx;
    const facedY = player.tileY + step.dy;

    let bestId: string | null = null;
    let bestFaced = false;
    let bestDistance = 0;
    for (const monsterId of this.monsterIndex.within(player, ATTACK_RANGE_TILES, this.attackTargetBuffer)) {
      // The index holds only the living — `killMonster` removes the entry — so this lookup is
      // really about reading the position; a miss would mean the two had drifted apart.
      const monster = this.state.monsters.get(monsterId);
      if (monster === undefined) {
        continue;
      }
      const faced = monster.tileX === facedX && monster.tileY === facedY;
      const distance = chebyshevDistance(player, monster);
      // The three rules in the order they are written: the faced tile wins, then the shorter
      // reach, then the lower id.
      const better =
        bestId === null ||
        (faced !== bestFaced
          ? faced
          : distance !== bestDistance
            ? distance < bestDistance
            : monsterId < bestId);
      if (better) {
        bestId = monsterId;
        bestFaced = faced;
        bestDistance = distance;
      }
    }
    return bestId;
  }

  /**
   * One equip request. Ignored outright — no store call, no `EquipmentChanged` — for a request
   * naming no equipment item at all (an unknown key, one that is not `equipment`, or a slot whose
   * family does not match the item's, design §1.3): unlike a held-or-not question, that is not
   * something the store has any way to answer.
   */
  private handleEquipItem(client: RoomClient, message: EquipItemRequest): void {
    const session = client.userData;
    if (!session || this.inventoryStore === null) {
      return;
    }
    const itemKey = message?.itemKey;
    const slot = message?.slot;
    if (typeof itemKey !== "string" || !isEquipmentSlot(slot) || session.equipRequestPendingSlots.has(slot)) {
      return;
    }
    const definition = ITEM_DEFINITIONS.find((item) => item.key === itemKey);
    if (
      definition === undefined ||
      definition.equipment === undefined ||
      definition.equipment.slot !== slotFamily(slot)
    ) {
      return;
    }
    void this.settleEquipRequest(
      client,
      slot,
      () => this.inventoryStore!.equip(this.equipOwnerKey(client), itemKey, slot),
      itemKey,
    );
  }

  private handleUnequipItem(client: RoomClient, message: UnequipItemRequest): void {
    const session = client.userData;
    if (!session || this.inventoryStore === null) {
      return;
    }
    const slot = message?.slot;
    if (!isEquipmentSlot(slot) || session.equipRequestPendingSlots.has(slot)) {
      return;
    }
    // Whether this un-equips anything at all is the store's own answer, not the session's cache
    // of what it was before the call: that cache can already be stale (a sibling session's equip
    // the store has recorded but this session's own cache has no way to have learned about), and
    // reporting `applied` off it would tell a client nothing changed when the store just did.
    void this.settleEquipRequest(
      client,
      slot,
      () => this.inventoryStore!.unequip(this.equipOwnerKey(client), slot),
      null,
    );
  }

  private equipOwnerKey(client: RoomClient): string {
    return client.userData?.ownerKey ?? client.sessionId;
  }

  /**
   * Re-skins a live player. No position/proximity work: avatarSkin is a plain schema field,
   * already synced to every viewer by the normal Player patch — the only thing this touches.
   */
  private handleChangeSkin(client: RoomClient, message: ChangeSkinRequest): void {
    const session = client.userData;
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) {
      return;
    }
    const skin = message?.skin;
    if (typeof skin !== "number" || !Number.isInteger(skin) || skin < 0 || skin >= AVATAR_SKIN_COUNT) {
      return;
    }
    player.avatarSkin = skin;
  }

  /**
   * Shared tail of {@link handleEquipItem} and {@link handleUnequipItem}: run one store call, then
   * decide whether its answer is still the newest thing to have happened to this session's `slot`.
   *
   * `applyTo` is what the cache becomes on a change — the item just equipped, or null for an
   * unequip — supplied by the caller rather than re-derived here, because only the caller knows
   * which of the two requests this is.
   *
   * `equipRequestPendingSlots` only saves a duplicate request its own round trip; correctness
   * comes entirely from the `equipCacheVersions[slot]` compare below, which is what lets a slower,
   * still-in-flight `hydrateEquipmentCache` or a second overlapping request on the *same* slot
   * lose without corrupting the cache — the same discipline `settlePossessionGrant` applies to
   * possession grants. A request on a *different* slot never reaches this compare at all, since it
   * runs its own, independent call to this same method (design §4.2).
   */
  private async settleEquipRequest(
    client: RoomClient,
    slot: EquipmentSlot,
    run: () => Promise<boolean>,
    applyTo: string | null,
  ): Promise<void> {
    const session = client.userData;
    if (!session) {
      return;
    }
    session.equipRequestPendingSlots.add(slot);
    const versionAtStart = session.equipCacheVersions[slot];

    let applied: boolean;
    try {
      applied = await run();
    } catch (cause) {
      console.warn(`[zep-test] could not update equipment for ${this.equipOwnerKey(client)}`, cause);
      const current = this.clientsBySession.get(client.sessionId)?.userData;
      if (current) {
        current.equipRequestPendingSlots.delete(slot);
      }
      return;
    }

    // Re-resolved after the await, exactly as `awardLoot` does: the session may have left the
    // room while the store was answering.
    const current = this.clientsBySession.get(client.sessionId)?.userData;
    if (!current) {
      return;
    }
    current.equipRequestPendingSlots.delete(slot);
    if (current.equipCacheVersions[slot] !== versionAtStart) {
      // A newer write for this slot already landed while this one was in flight; that one's
      // answer stands, and this one's is neither applied nor announced.
      return;
    }
    if (applied) {
      if (applyTo === null) {
        delete current.equippedItemKeys[slot];
      } else {
        current.equippedItemKeys[slot] = applyTo;
      }
      current.equipCacheVersions[slot] += 1;
    }
    this.clientsBySession.get(client.sessionId)?.send(ServerMessage.EquipmentChanged, {
      slot,
      itemKey: current.equippedItemKeys[slot] ?? null,
      applied,
    } satisfies EquipmentChanged);
  }

  /**
   * Files one kill's drops and, only once the store has committed them, tells the killer.
   *
   * Async and never awaited by its caller, which is the whole shape of it: the grant belongs to an
   * account rather than to a session, so it stays correct if the killer leaves in the middle of
   * it, and the room must not stop simulating while a database answers.
   */
  private async awardLoot(lastHit: LastHit, grants: readonly LootGrant[]): Promise<void> {
    const store = this.inventoryStore;
    if (store === null || grants.length === 0) {
      return;
    }
    // No SSO means no account to file under, so the session id stands in against the in-memory
    // store — which is what keeps this whole path exercised in local development.
    const ownerKey = lastHit.ownerKey ?? lastHit.sessionId;

    // Possession items are credited to the killer's own session here, before this function's
    // first `await` (including one belonging to an earlier grant in this same array) — not after
    // `store.grantOnce` resolves. `awardLoot` runs synchronously up to its first `await`, in the
    // same call stack turn as the kill that produced `grants`; a client that kills and, with no
    // microtask boundary in between, immediately steps onto a gated door in the same message
    // batch must see the grant already applied. Waiting even one microtask — the shortest an
    // `await store.grantOnce(...)` can take — is measurably too late for that case.
    //
    // A key already in `confirmedPossessionKeys` is skipped entirely: it is proven, so there is
    // nothing left to credit and nothing a losing sibling call could ever take back. Everything
    // else is counted into `pendingPossessionGrants` rather than compared against a snapshot
    // "was this already cached" boolean — two kills that both drop the same key can have their
    // `awardLoot` calls overlap, and only a count that every one of them decrements lets the last
    // one to resolve tell "nobody has confirmed this yet" apart from "somebody still might".
    const killerSession = this.clientsBySession.get(lastHit.sessionId)?.userData;
    if (killerSession !== undefined) {
      for (const grant of grants) {
        const possessionDefinition = ITEM_DEFINITIONS.find((item) => item.key === grant.itemKey);
        if (possessionDefinition?.possession !== true || killerSession.confirmedPossessionKeys.has(grant.itemKey)) {
          continue;
        }
        killerSession.ownedPossessionKeys.add(grant.itemKey);
        const pending = killerSession.pendingPossessionGrants.get(grant.itemKey) ?? 0;
        killerSession.pendingPossessionGrants.set(grant.itemKey, pending + 1);
      }
    }

    for (const grant of grants) {
      const definition = ITEM_DEFINITIONS.find((item) => item.key === grant.itemKey);
      if (definition === undefined) {
        // Boot validation refuses a loot row naming a key that is not in the catalogue, so this
        // is unreachable in production and is a lost toast rather than a lost item if it is not.
        continue;
      }

      let total: number;
      let quantity: number;
      if (definition.possession === true) {
        let granted: boolean;
        try {
          granted = await store.grantOnce(ownerKey, grant.itemKey);
        } catch (cause) {
          // Same rule as the `add` branch below: nothing is sent, and the remaining grants are
          // still attempted since they are independent rows.
          console.warn(`[zep-test] could not credit ${grant.itemKey} to ${ownerKey}`, cause);
          this.settlePossessionGrant(killerSession, grant.itemKey, false);
          continue;
        }
        // Already held, or the bag was full — `InventoryStore.grantOnce` makes the two
        // indistinguishable, and both mean nothing was stored this call. `settlePossessionGrant`
        // is what decides whether the optimistic credit survives a `false` here: it does, if a
        // sibling call for the same key is still pending or already confirmed it.
        this.settlePossessionGrant(killerSession, grant.itemKey, granted);
        if (!granted) {
          continue;
        }
        total = 1;
        quantity = 1;
      } else {
        let credited: number | null;
        try {
          credited = await store.add(ownerKey, grant.itemKey, grant.quantity);
        } catch (cause) {
          // Nothing is sent. "You picked it up" followed by an empty bag next login is the worse
          // of the two failures; the opposite — stored but unannounced — resolves itself on the
          // next bag open. The remaining grants are still attempted: they are independent rows.
          console.warn(
            `[zep-test] could not credit ${grant.quantity}x ${grant.itemKey} to ${ownerKey}`,
            cause,
          );
          continue;
        }
        if (credited === null) {
          // A full bag is a result rather than a fault (InventoryStore.add). Nothing was stored,
          // so by the rule above nothing is announced.
          continue;
        }
        total = credited;
        quantity = grant.quantity;
      }

      // Resolved now rather than before the await: the killer may have left the room, or walked
      // through a door into another one, while the store was answering.
      this.clientsBySession.get(lastHit.sessionId)?.send(ServerMessage.ItemGranted, {
        itemKey: definition.key,
        // Sent rather than looked up, so a client older than the catalogue still draws the row it
        // was handed — `GET /api/inventory` hands its rows over on the same terms.
        name: definition.name,
        icon: definition.icon,
        quantity,
        total,
        // Present only for an equipment item, same as `GET /api/inventory` — without it, the row
        // this grant builds (`InventoryPanel.buildRow`) has no equip button until the bag is
        // closed and reopened, since that button is gated on this field being defined.
        damageReductionRatio: definition.equipment?.stats.damageReduction,
      } satisfies ItemGranted);
    }
  }

  /**
   * Resolves one `awardLoot` call's own attempt at crediting `itemKey` against what
   * `store.grantOnce` actually answered, without assuming this is the only attempt in flight for
   * that key on this session — see {@link PlayerSession.pendingPossessionGrants}.
   *
   * `succeeded` true confirms the key permanently: `confirmedPossessionKeys` is the one thing no
   * later call, winning or losing, is allowed to undo. `succeeded` false only evicts the
   * optimistic credit once every attempt this session has made for the key has reported in
   * (`pending` counts down to zero) and none of them confirmed it — otherwise this call, if it
   * happens to be the one that resolves first, would erase a credit a still-pending or
   * already-succeeded sibling call is owed, purely because of the order two unrelated database
   * round trips happened to come back in.
   */
  private settlePossessionGrant(
    session: PlayerSession | undefined,
    itemKey: string,
    succeeded: boolean,
  ): void {
    if (session === undefined) {
      return;
    }
    if (succeeded) {
      session.confirmedPossessionKeys.add(itemKey);
      session.pendingPossessionGrants.delete(itemKey);
      return;
    }
    const remaining = (session.pendingPossessionGrants.get(itemKey) ?? 1) - 1;
    if (remaining > 0) {
      session.pendingPossessionGrants.set(itemKey, remaining);
      return;
    }
    session.pendingPossessionGrants.delete(itemKey);
    if (!session.confirmedPossessionKeys.has(itemKey)) {
      session.ownedPossessionKeys.delete(itemKey);
    }
  }

  /**
   * Files one kill's EXP and, if the store confirms a level-up, patches the public `Player.level`
   * field and fully heals the session (design-phase-w-level-system.md §6, §11 — last-hit only,
   * `awardLoot`'s own rule).
   *
   * Async and never awaited by its caller, `awardLoot`'s own shape and reason: the grant belongs
   * to an account rather than to a session, so it stays correct if the killer leaves mid-flight,
   * and the room must not stop simulating while a database answers. Calls `store.grantExp` directly
   * rather than through a room-owned queue — serializing every store call for one account, from
   * whichever room instance issued it, is now `CachedProgressStore`'s job, not this room's
   * (design-phase-w2-level-client.md §1.2, formerly `queueProgressUpdate`/`progressQueueByOwner`
   * here). `levelSystem-raceCondition.test.ts` is the regression coverage that guarantee still
   * holds.
   */
  private async awardExp(
    lastHit: LastHit,
    monsterId: string,
    amount: number,
    now: number,
  ): Promise<void> {
    const store = this.progressStore;
    if (store === null) {
      return;
    }
    const ownerKey = lastHit.ownerKey ?? lastHit.sessionId;
    let total: number;
    try {
      total = await store.grantExp(ownerKey, amount);
    } catch (cause) {
      console.warn(`[zep-test] could not credit ${amount} exp to ${ownerKey}`, cause);
      return;
    }

    // Re-resolved after the await, exactly as `awardLoot` does: the killer may have left the room,
    // or walked through a door into another one, while the store was answering.
    const session = this.clientsBySession.get(lastHit.sessionId)?.userData;
    const player = this.state.players.get(lastHit.sessionId);
    if (!session || !player) {
      return;
    }
    // Subscriptions apply committed writes in order before this continuation; do not replay one
    // after a newer account update, or heal the killer twice. Plain stores retain their old path.
    if (this.progressSubscriptions.get(lastHit.sessionId)?.unsubscribe === undefined) {
      this.updateProgress(lastHit.sessionId, total, true);
    }
    const newLevel = levelForExp(session.totalExp);

    this.clientsBySession.get(lastHit.sessionId)?.send(ServerMessage.ExpGranted, {
      monsterId,
      amount,
      totalExp: session.totalExp,
      level: newLevel,
      expToNextLevel: remainingExpToNextLevel(session.totalExp),
      hpMax: this.totalMaxHp(session),
      hpRemaining: Math.max(0, session.hp),
    } satisfies ExpGranted);
  }

  /**
   * A walkable tile within `area.spreadRadiusInTiles` of `area`'s centre. Spreading matters
   * beyond looks: with everyone stacked on one tile every client sits inside every other
   * client's view radius, so interest management filters nothing and a load test measures the
   * worst case only.
   *
   * The area is a parameter rather than `this.spawn` so that a portal arrival and a plain join
   * share this one placement path; both centres are boot-validated as walkable.
   *
   * Rejection sampling rather than a precomputed list of walkable tiles — 74% of grand-plaza's
   * spawn square is walkable, so a draw succeeds in ~1.3 attempts and 16 consecutive misses has
   * probability ~5e-10. The fallback is the centre tile, which boot validates as walkable.
   */
  private pickSpawnTile(area: SpawnArea): TilePosition {
    const radius = area.spreadRadiusInTiles;
    if (radius <= 0) {
      return { tileX: area.tileX, tileY: area.tileY };
    }
    const span = radius * 2 + 1;
    for (let attempt = 0; attempt < SPAWN_SAMPLE_ATTEMPTS; attempt++) {
      // Draws outside the map need no separate guard: isWalkable() already reports them blocked.
      const tileX = area.tileX - radius + Math.floor(this.random() * span);
      const tileY = area.tileY - radius + Math.floor(this.random() * span);
      if (this.collisionMap.isWalkable(tileX, tileY)) {
        return { tileX, tileY };
      }
    }
    return { tileX: area.tileX, tileY: area.tileY };
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

  /**
   * Builds this room's monsters, or does nothing at all when the table names no monster here.
   *
   * "Nothing at all" is the contract, not an optimisation: no second index is constructed, no
   * simulation loop is started, and no monster code runs on any later path. The rooms this
   * feature must not slow down are the ones PoC #2 measured.
   *
   * Async, and `onCreate` awaits it, for a boss row's sake only (design-phase-i-boss-monster.md
   * §2.4): every other row still spawns synchronously within this same call, since nothing else
   * here ever awaits.
   */
  private async populateMonsters(): Promise<void> {
    const spawns = this.monsterSpawns();
    if (spawns.length === 0) {
      return;
    }
    const types = this.monsterTypes();
    this.monsterIndex = this.createMonsterIndex(this.collisionMap);

    for (const definition of spawns) {
      const type = types.get(definition.kind);
      if (type === undefined) {
        // Boot validation refuses an unknown kind, so this is unreachable in production. A
        // fixture that skips that validation loses the row rather than the whole room.
        continue;
      }
      const runtime: MonsterRuntime = {
        definition,
        type,
        state: MonsterAiState.Idle,
        nextStepAt: 0,
        nextAttackAt: 0,
        respawnAt: 0,
        hp: type.maxHp,
        lastHitBy: null,
        combat: type.isBoss === true ? { combatants: new Set(), wipeResetAt: null } : null,
      };
      this.monsterRuntimes.set(definition.id, runtime);

      if (type.isBoss === true && this.bossStateStore !== null) {
        // The one DB read this feature makes, and only once per boss row per room creation — the
        // tick loop never touches the store (§6.5).
        //
        // A store that cannot answer costs this one row its start state and nothing else: the boss
        // starts alive, exactly as it does in a room built with no store at all. Letting the
        // rejection out would fail `onCreate` itself, taking hunting-ground's other 20 monsters —
        // and its movement and its chat — down with a Postgres hiccup, which is precisely what
        // `db/status.ts` says must not happen. (Boot-time failure is still fatal by design; that
        // decision belongs to `index.ts`, not to a room already being built.)
        let defeatedAt: number | null = null;
        try {
          defeatedAt = await this.bossStateStore.getLastDefeatedAt(definition.id);
        } catch (cause) {
          console.warn(`[zep-test] could not read ${definition.id}'s defeat time`, cause);
        }
        const now = Date.now();
        if (defeatedAt !== null && now - defeatedAt < BOSS_RESPAWN_MS) {
          runtime.state = MonsterAiState.Dead;
          runtime.respawnAt = defeatedAt + BOSS_RESPAWN_MS;
          // Not spawnMonster(): this row starts outside state.monsters, exactly as a normal kill
          // leaves it, and the tick loop's own Dead-state handling (decideMonsterAction) counts
          // the remainder of BOSS_RESPAWN_MS down and respawns it the same way a normal respawn
          // delay does.
          continue;
        }
      }
      this.spawnMonster(definition.id, runtime);
    }
    // monsterRuntimes.size, not state.monsters.size — see the tick-loop gate in onCreate for why.
    this.hasMonsters = this.monsterRuntimes.size > 0;
  }

  /**
   * Puts a monster on its spawn tile — the first placement at `onCreate` and every respawn after
   * it take this one path, which is the point: a respawn is a join, and it has to reach the
   * clients' views the same way a join does.
   *
   * The view refresh finds nobody at `onCreate`, since the room has no clients yet.
   */
  private spawnMonster(monsterId: string, runtime: MonsterRuntime): void {
    const { at, kind } = runtime.definition;
    this.state.monsters.set(
      monsterId,
      new Monster({ kind, tileX: at.tileX, tileY: at.tileY, facing: Direction.Down }),
    );
    // Index before view, as everywhere else in this room.
    this.monsterIndex.insert(monsterId, at);
    this.refreshMonsterViewAround(monsterId, null, at);
    runtime.state = MonsterAiState.Idle;
    // A respawn is a new monster: it arrives whole, and it owes its drops to nobody.
    runtime.hp = runtime.type.maxHp;
    runtime.lastHitBy = null;
    if (runtime.combat !== null) {
      // And it is nobody's fight yet. Without this the new boss inherits the previous one's
      // roster, so anybody who hit that boss and is still in the room holds a seat this fight can
      // never free — its wipe would be undeclarable for the rest of the room's life. `wipeResetAt`
      // is cleared rather than armed: an empty roster here means "no fight has started", not "the
      // group was wiped".
      runtime.combat.combatants.clear();
      runtime.combat.wipeResetAt = null;
    }
  }

  /**
   * Takes a monster off the map and starts its respawn timer. Death is a deletion rather than a
   * flag so that it travels the leave path a player already travels; a `dead: boolean` would
   * invent a third condition ("visible but not interactable") for both sides to handle.
   *
   * No combat exists yet to call this — Pass E's damage handling is what will. It is written and
   * reachable now so that the view bookkeeping of a death and a respawn can be tested before the
   * thing that triggers them exists.
   */
  private killMonster(monsterId: string, now: number): void {
    const runtime = this.monsterRuntimes.get(monsterId);
    const monster = this.state.monsters.get(monsterId);
    if (!runtime || !monster) {
      return;
    }
    const from = { tileX: monster.tileX, tileY: monster.tileY };
    this.monsterIndex.remove(monsterId);
    this.refreshMonsterViewAround(monsterId, from, null);
    // After the bookkeeping above, exactly as in `onLeave`: this deletion is what carries the
    // removal into every StateView, so `refreshMonsterViewAround` only has to drop the ledger.
    this.state.monsters.delete(monsterId);
    runtime.state = MonsterAiState.Dead;
    runtime.respawnAt = now + runtime.type.respawnDelayMs;

    if (runtime.type.isBoss === true && this.bossStateStore !== null) {
      // Fire-and-forget, exactly as `awardLoot`'s own store calls are — the tick loop must not
      // stall on a database round trip (design §2.5, §6.5). `runtime.respawnAt` above already
      // covers this room's own respawn for as long as it stays alive; this write is only for a
      // room instance created later, which reads it back in `populateMonsters`.
      //
      // Caught where it happens, for the reason `onJoin`'s hydration calls are: an unhandled
      // rejection would kill the process, and the worst a lost record can do is start the boss
      // alive in some later room instance.
      void this.bossStateStore.recordDefeat(monsterId, now).catch((cause) => {
        console.warn(`[zep-test] could not record ${monsterId}'s defeat`, cause);
      });
    }
  }

  /**
   * Marks `sessionId` as fighting `runtime`'s boss — a no-op for every non-boss runtime, since
   * `combat` is null there. Cancels a pending wipe reset too: a fresh combatant is exactly what
   * "the group is still going" means (design §6.6), whether they are the one swinging or the one
   * just hit.
   */
  private addBossCombatant(runtime: MonsterRuntime, sessionId: string): void {
    if (runtime.combat === null) {
      return;
    }
    runtime.combat.combatants.add(sessionId);
    runtime.combat.wipeResetAt = null;
  }

  /**
   * Drops `sessionId` out of every boss's combat roster and arms the wipe-reset grace timer on
   * each roster their departure emptied (design §6.6). The one exit from a boss fight, called by
   * both ways out of one: dying, and leaving the room.
   *
   * *Every* boss rather than only the one involved: a player who dies to a squirrel while fighting
   * the boss has left that fight exactly as completely as one killed by the boss itself, and a
   * corpse left enrolled could never be brought down to zero again — the wipe would be
   * undeclarable for as long as the room lived.
   *
   * A disconnect arms the timer on the same terms as a death, deliberately: the rule is "the group
   * that was fighting this boss is all gone", and it cannot depend on *how* they went, or leaving
   * would be strictly better than dying — a lone attacker could whittle a boss down over several
   * visits, never risking the reset that dying costs, and take the 25% drop cheaply.
   *
   * A departure that leaves somebody behind arms nothing, which is what keeps one death from
   * resetting a fight the rest of the group is still in. Nor does the departure of somebody who
   * was not on the roster: re-arming an already-empty roster's timer would push a pending reset
   * out of reach every time a passer-by left the room.
   */
  private leaveBossCombat(sessionId: string, now: number): void {
    for (const { combat } of this.monsterRuntimes.values()) {
      if (combat === null || !combat.combatants.delete(sessionId)) {
        continue;
      }
      if (combat.combatants.size === 0) {
        combat.wipeResetAt = now + WIPE_RESET_GRACE_MS;
      }
    }
  }

  /**
   * One simulation step for every monster in the room.
   *
   * `now` is a parameter and is never re-read from the clock inside: every decision in one tick
   * has to see one timestamp or the same inputs stop producing the same tick. It is also what
   * lets the tests drive the loop directly instead of waiting on a timer.
   *
   * Iterates the runtimes rather than `state.monsters` because a dead monster has no state entry
   * and still has a respawn to count down.
   */
  private tick(now: number): void {
    for (const [monsterId, runtime] of this.monsterRuntimes) {
      // Boss wipe reset (design §6.6): the whole group that was fighting this boss died and the
      // grace window has passed with nobody rejoining. `killMonster` is not called — this is a
      // full-heal, not a kill, so `respawnAt` and the DB record are both left untouched.
      if (runtime.combat !== null && runtime.combat.wipeResetAt !== null && now >= runtime.combat.wipeResetAt) {
        runtime.hp = runtime.type.maxHp;
        runtime.combat.wipeResetAt = null;
      }

      const monster = this.state.monsters.get(monsterId);
      const { at } = runtime.definition;
      const snapshot: MonsterSnapshot = {
        id: monsterId,
        state: runtime.state,
        tileX: monster?.tileX ?? at.tileX,
        tileY: monster?.tileY ?? at.tileY,
        spawn: at,
        wanderRadiusTiles: runtime.definition.wanderRadiusTiles,
        nextStepAt: runtime.nextStepAt,
        nextAttackAt: runtime.nextAttackAt,
        respawnAt: runtime.respawnAt,
      };

      const targets = this.monsterTargets;
      targets.length = 0;
      if (monster !== undefined) {
        const nearby = this.proximityIndex.within(
          monster,
          runtime.type.aggroRadiusTiles,
          this.monsterAggroBuffer,
        );
        for (const sessionId of nearby) {
          const player = this.state.players.get(sessionId);
          if (player) {
            targets.push({ sessionId, tileX: player.tileX, tileY: player.tileY });
          }
        }
      }

      const action = decideMonsterAction(snapshot, targets, now, runtime.type);
      runtime.state = action.state;

      switch (action.kind) {
        case MonsterActionKind.Step:
          runtime.nextStepAt = action.nextStepAt;
          if (monster !== undefined) {
            this.stepMonster(monsterId, monster, action.directions);
          }
          break;
        case MonsterActionKind.Attack:
          runtime.nextAttackAt = action.nextAttackAt;
          if (monster !== undefined && action.facing !== null) {
            monster.facing = action.facing;
          }
          if (action.targetSessionId !== null) {
            this.damagePlayer(action.targetSessionId, monsterId, runtime.type.damage, now);
          }
          break;
        case MonsterActionKind.Respawn:
          this.spawnMonster(monsterId, runtime);
          break;
        case MonsterActionKind.Hold:
          break;
      }
    }

    // After the monsters, so that a player hit this tick cannot also be healed by it.
    this.recoverOutOfCombat(now);
  }

  /**
   * Every equipped slot's `stats.damageReduction`, combined multiplicatively (design §5.4:
   * `1 - Π(1-rᵢ)`) rather than summed — a plain sum of several slots' ratios can exceed 1.0 and
   * make the wearer literally unkillable, the exact state `damagePlayer`'s own floor-to-1 guard
   * below exists to prevent for a *single* slot. Each `rᵢ < 1` keeps the combined result `< 1` too,
   * however many slots contribute, so armor/helmet/cloak can share this one pool safely once any
   * of them actually carries the axis (today, only `leather-armor`'s armor slot does).
   */
  private equippedDamageReduction(session: PlayerSession): number {
    let remainingFraction = 1;
    for (const slot of EQUIPMENT_SLOTS) {
      const itemKey = session.equippedItemKeys[slot];
      if (itemKey === undefined) {
        continue;
      }
      const definition = ITEM_DEFINITIONS.find((item) => item.key === itemKey);
      const ratio = definition?.equipment?.stats.damageReduction;
      if (ratio !== undefined) {
        remainingFraction *= 1 - ratio;
      }
    }
    return 1 - remainingFraction;
  }

  /**
   * One monster's blow landing on one player.
   *
   * The number goes to the victim and to nobody else — the discipline that kept monster health
   * out of `RoomState`, applied to the other side: onlookers get the monster's attack animation
   * and no figure. Death costs the walk back and, since Phase W-1 (design-phase-w-level-system.md
   * §11.0), 1% of accumulated EXP — never a level, and never at all for an account in
   * `adminOwnerKeys` — applied by {@link applyDeathExpPenalty} below.
   */
  private damagePlayer(sessionId: string, monsterId: string, damage: number, now: number): void {
    const client = this.clientsBySession.get(sessionId);
    const session = client?.userData;
    const player = this.state.players.get(sessionId);
    if (!client || !session || !player) {
      return;
    }
    const runtime = this.monsterRuntimes.get(monsterId);
    if (runtime !== undefined) {
      this.addBossCombatant(runtime, sessionId);
    }

    const reduction = this.equippedDamageReduction(session);
    // Floored rather than rounded, and never below 1: a hit that reduces to nothing would make an
    // equipped player literally unkillable, which is a different feature than "hits less hard".
    const appliedDamage = reduction > 0 ? Math.max(1, Math.floor(damage * (1 - reduction))) : damage;

    session.hp -= appliedDamage;
    // "Taken", not "dealt": swinging at something does not keep you in combat, being swung at
    // does. This is what COMBAT_EXIT_MS is measured from.
    session.lastDamagedAt = now;
    const hpRemaining = Math.max(0, session.hp);
    client.send(ServerMessage.PlayerHit, {
      monsterId,
      // The damage actually applied, not the monster's raw stat: the client holds no stat table
      // of its own, the same reason `MonsterHit.damage` is never anything but what landed.
      damage: appliedDamage,
      hpRemaining,
      hpMax: this.totalMaxHp(session),
    } satisfies PlayerHit);

    if (hpRemaining > 0) {
      return;
    }
    this.leaveBossCombat(sessionId, now);
    session.hp = this.totalMaxHp(session);
    // The existing message for "the server moved you without you walking", rather than a death
    // message of its own: the home warp already proved that path, and the client reads
    // `hpRemaining === 0` on the hit above as the death itself.
    this.warpTo(client, player, this.home);
    // Fire-and-forget, `awardLoot`'s own reason — a database round trip must never hold the
    // monster tick that reached this branch.
    void this.applyDeathExpPenalty(sessionId, session);
  }

  /**
   * The death EXP penalty (design-phase-w-level-system.md §11.0): 1% of accumulated EXP, floored
   * at the account's current level's minimum, so a death costs progress within a level but never
   * the level itself. Exempts `adminOwnerKeys` entirely — an allowlist injected at boot
   * (`RoomCreateOptions.adminOwnerKeys`) from the `ADMIN_OWNER_KEYS` env var, never a key literal
   * in this codebase.
   *
   * Falls back to the session id when there is no SSO identity, `awardExp`'s own convention: local
   * development still exercises this path against the in-memory store. Calls `store
   * .applyDeathPenalty` directly rather than through a room-owned queue, `awardExp`'s own reason
   * (design-phase-w2-level-client.md §1.2) — including for the `floor` argument below: it is
   * computed from `session.totalExp` right here, which is this room's best knowledge *at the moment
   * this call is issued*, not necessarily this account's real level by the time the call actually
   * runs (a kill and this same session's death landing in the same tick issue a grant and this call
   * back-to-back, before the grant's own round trip has updated `session.totalExp`). This room no
   * longer has a queue of its own to delay that read with — `CachedProgressStore.applyDeathPenalty`
   * re-derives the floor from its own cache once it is actually this call's turn, which is where
   * that correction now lives. See its doc comment, and `levelSystem-raceCondition.test.ts` for the
   * regression this still has to pass.
   */
  private async applyDeathExpPenalty(sessionId: string, session: PlayerSession): Promise<void> {
    const store = this.progressStore;
    if (store === null) {
      return;
    }
    const ownerKey = session.ownerKey ?? sessionId;
    if (this.adminOwnerKeys.has(ownerKey)) {
      return;
    }
    const floor = cumulativeExpForLevel(levelForExp(session.totalExp));
    let result: number | null;
    try {
      result = await store.applyDeathPenalty(ownerKey, floor);
    } catch (cause) {
      console.warn(`[zep-test] could not apply the death exp penalty to ${ownerKey}`, cause);
      return;
    }
    if (result === null) {
      return;
    }
    if (this.progressSubscriptions.get(sessionId)?.unsubscribe === undefined) {
      this.updateProgress(sessionId, result, false);
    }
  }

  /**
   * Gives health back to everyone who has been left alone for COMBAT_EXIT_MS.
   *
   * Sends nothing at all. The client redraws the same curve from COMBAT_EXIT_MS,
   * COMBAT_RECOVERY_HP_PER_TICK and the time of its own last `PlayerHit`, so a per-tick unicast
   * to every hurt player would be exactly the traffic this design keeps off the wire — and the
   * next `PlayerHit` carries the server's number anyway, which bounds how far the two can drift.
   *
   * Rides the monster tick, so it runs only in a room that has monsters. That is the only room
   * health can be lost in, and any room change restores it in full regardless.
   *
   * Per-session `totalMaxHp` and COMBAT_RECOVERY_FRACTION_PER_TICK replace the flat
   * PLAYER_MAX_HP/COMBAT_RECOVERY_HP_PER_TICK pair (design-phase-w-level-system.md §4.4): a level
   * raises the cap, and an absolute per-tick amount would make full recovery take longer in
   * wall-clock time the higher a player's level climbs — the same "recovery might as well not
   * exist" problem Phase A fixed once already, reappearing at the other end of the curve. At
   * level 1 (`totalMaxHp === PLAYER_MAX_HP`) this is `round(100 * 0.03) === 3`, identical to the
   * constant it replaces — the anchor invariant this Phase's tests pin.
   */
  private recoverOutOfCombat(now: number): void {
    for (const client of this.clientsBySession.values()) {
      const session = client.userData;
      if (!session) {
        continue;
      }
      const cap = this.totalMaxHp(session);
      // `lastDamagedAt` is 0 for a player who has never been hit, and this guard is what stops
      // that from reading as "out of combat since the epoch" on somebody already at full health.
      if (session.hp >= cap || now - session.lastDamagedAt < COMBAT_EXIT_MS) {
        continue;
      }
      const recoveryPerTick = Math.max(1, Math.round(cap * COMBAT_RECOVERY_FRACTION_PER_TICK));
      session.hp = Math.min(cap, session.hp + recoveryPerTick);
    }
  }

  /**
   * Applies the first of `directions` the collision map allows, using the same resolver the
   * players walk with — a monster and a player obey one set of collision rules, and duplicating
   * a verified 39-line function to say so twice would be the wrong kind of saving.
   *
   * A monster that finds every candidate blocked still turns, for the reason a player does: the
   * turn is information even when the position does not change.
   */
  private stepMonster(
    monsterId: string,
    monster: Monster,
    directions: readonly Direction[],
  ): void {
    const from = { tileX: monster.tileX, tileY: monster.tileY };
    for (const direction of directions) {
      const destination = this.movementResolver.resolveStep(from, direction, this.collisionMap);
      if (destination === null) {
        continue;
      }
      monster.facing = direction;
      monster.tileX = destination.tileX;
      monster.tileY = destination.tileY;
      // Index strictly first. Reverse these and the monster is left permanently visible, or
      // permanently invisible, to whoever was on the boundary — quietly, and only for them.
      this.monsterIndex.move(monsterId, destination);
      this.refreshMonsterViewAround(monsterId, from, destination);
      return;
    }
    const [blocked] = directions;
    if (blocked !== undefined) {
      monster.facing = blocked;
    }
  }

  /**
   * Recomputes one client's monster view from scratch. {@link refreshViewFor}'s mirror image, and
   * called from the same three places: after a join, after an accepted step, and after a warp.
   *
   * Never reached in a room without monsters — every caller is behind the `hasMonsters` guard.
   */
  private refreshMonsterViewFor(sessionId: string): void {
    const viewer = this.state.players.get(sessionId);
    const view = this.clientsBySession.get(sessionId)?.view;
    const viewed = this.monstersViewedBySession.get(sessionId);
    if (!viewer || !view || !viewed) {
      return;
    }

    const inRange = this.monstersInRange;
    inRange.clear();
    for (const id of this.monsterIndex.within(viewer, VIEW_RADIUS_TILES, this.monsterQueryBuffer)) {
      inRange.add(id);
    }

    for (const id of inRange) {
      if (viewed.has(id)) {
        continue;
      }
      const monster = this.state.monsters.get(id);
      if (monster) {
        view.add(monster);
        viewed.add(id);
      }
    }

    for (const id of viewed) {
      if (inRange.has(id)) {
        continue;
      }
      // A monster that has died is already out of `state.monsters`; that deletion carries the
      // removal to the client, so only the ledger entry is dropped here.
      const monster = this.state.monsters.get(id);
      if (monster) {
        view.remove(monster);
      }
      viewed.delete(id);
    }
  }

  /**
   * Applies one monster's position change to just the views it can possibly affect —
   * {@link refreshViewsAround} for monsters, with the same argument convention: `from` null is a
   * spawn, `to` null is a death, and `state.monsters` and `monsterIndex` must already agree with
   * `to` by the time this is called.
   *
   * Shorter than its player twin by exactly one thing: a monster has no StateView of its own, so
   * there is no subject view to rebuild at the end.
   */
  private refreshMonsterViewAround(
    monsterId: string,
    from: TilePosition | null,
    to: TilePosition | null,
  ): void {
    const anchor = to ?? from;
    if (anchor === null) {
      return;
    }
    const subject = to === null ? null : this.state.monsters.get(monsterId);
    const step = from !== null && to !== null ? chebyshevDistance(from, to) : 0;

    // One query rather than `within(from) ∪ within(to)`, for the reason the player path gives:
    // radius + step around `to` is a superset of both and needs no deduplication.
    const viewers = this.proximityIndex.within(
      anchor,
      VIEW_RADIUS_TILES + step,
      this.monsterNeighbourBuffer,
    );

    for (const viewerId of viewers) {
      const viewer = this.state.players.get(viewerId);
      const view = this.clientsBySession.get(viewerId)?.view;
      const viewed = this.monstersViewedBySession.get(viewerId);
      if (!viewer || !view || !viewed) {
        continue;
      }

      const wasVisible = from !== null && chebyshevDistance(viewer, from) <= VIEW_RADIUS_TILES;
      const isVisible = to !== null && chebyshevDistance(viewer, to) <= VIEW_RADIUS_TILES;
      if (wasVisible === isVisible) {
        continue;
      }

      if (isVisible) {
        if (subject && !viewed.has(monsterId)) {
          view.add(subject);
          viewed.add(monsterId);
        }
      } else {
        // A null subject is a death: the `state.monsters` deletion that follows carries the
        // removal into every view by itself, so only the ledger is dropped here.
        if (subject) {
          view.remove(subject);
        }
        viewed.delete(monsterId);
      }
    }
  }
}

/**
 * The wire form of an object row, built field by field rather than by spreading the row. A spread
 * would carry `answerIndex` onto the wire, and a quiz whose answer is in the network tab has given
 * away the only thing it had; it would also ship the authoring coordinates, which the client
 * already has from the markers.
 *
 * `quests` is resolved by the caller rather than looked up here: it depends on who is reading (each
 * row carries that account's own progress), and this function is otherwise a pure projection of one
 * table row. Ignored for every kind but `Npc`, which is the only giver a quest can name.
 */
function toInteraction(
  object: InteractableDefinition,
  quests?: readonly QuestState[],
): InteractableEntered {
  switch (object.kind) {
    case InteractableKind.Link:
      return {
        kind: object.kind,
        objectId: object.id,
        title: object.title,
        url: object.url,
        blocksMovement: object.blocksMovement ?? true,
      };
    case InteractableKind.Notice:
      return {
        kind: object.kind,
        objectId: object.id,
        title: object.title,
        body: object.body,
        blocksMovement: object.blocksMovement ?? true,
      };
    case InteractableKind.Quiz:
      return {
        kind: object.kind,
        objectId: object.id,
        title: object.title,
        question: object.question,
        choices: object.choices,
        blocksMovement: object.blocksMovement ?? true,
      };
    case InteractableKind.Npc:
      return {
        kind: object.kind,
        objectId: object.id,
        title: object.title,
        body: object.body,
        blocksMovement: object.blocksMovement ?? true,
        quests,
      };
  }
}

/**
 * One quest's wire form for one reader. `row` is null for a quest this account has never accepted
 * — the `Offered` state, which only an NPC panel ever shows.
 *
 * `killCount` is clamped here as well as in the store: a row written while the objective asked for
 * five kills outlives a redeploy that lowers it to three, and a progress bar reading "5 / 3" would
 * be the client's problem for a requirement change that is entirely the server's.
 */
function questState(quest: QuestDefinition, row: QuestRow | null): QuestState {
  return {
    questId: quest.id,
    title: quest.title,
    summary: quest.summary,
    objectiveText: quest.objectiveText,
    completionText: quest.completionText,
    status:
      row === null
        ? QuestStatus.Offered
        : row.completed
          ? QuestStatus.Completed
          : QuestStatus.Accepted,
    killCount: Math.min(row?.killCount ?? 0, quest.objective.count),
    requiredCount: quest.objective.count,
  };
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

/** Narrows an untrusted wire value to one of the eight known slots, same treatment `isDirection` gives a move. */
function isEquipmentSlot(value: unknown): value is EquipmentSlot {
  return typeof value === "string" && (EQUIPMENT_SLOTS as readonly string[]).includes(value);
}

/** Every slot's optimistic-concurrency counter, starting at 0 (design §1.2) — built with `.reduce` rather than eight literal fields, so a ninth slot would never need this touched. */
function initialEquipCacheVersions(): Record<EquipmentSlot, number> {
  return EQUIPMENT_SLOTS.reduce(
    (versions, slot) => ({ ...versions, [slot]: 0 }),
    {} as Record<EquipmentSlot, number>,
  );
}
