import Phaser from "phaser";
import {
  LANDMARK_DEFINITIONS,
  TILE_SIZE_PX,
  type ChatBroadcast,
  type JoinOptions,
  type MonsterHit,
  type PlayerHit,
} from "@zep-test/shared";
import { hideBootStatus, showBootError } from "../bootStatus";
import { AttackKey } from "../input/attackKey";
import { MovementKeys } from "../input/movementKeys";
import { resolveJoinOptions, updateAvatarSkin } from "../net/identity";
import { saveAvatarSkin } from "../net/profile";
import { RoomConnection, type PlayerSnapshot } from "../net/roomConnection";
import { resolveHomeRoomName } from "../net/roomTarget";
import { fadeFromBlack, fadeToBlack, showTransitionNotice } from "../transitionOverlay";
import { chooseAvatarSkin } from "../ui/avatarPicker";
import { BossVitals } from "../ui/bossVitals";
import { CharacterMenu } from "../ui/characterMenu";
import { ChatPanel } from "../ui/chatPanel";
import { HomeButton } from "../ui/homeButton";
import { InventoryPanel } from "../ui/inventoryPanel";
import { ItemToasts } from "../ui/itemToasts";
import { LandmarkPanel } from "../ui/landmarkPanel";
import { LootTablePanel } from "../ui/lootTablePanel";
import { Minimap, type MinimapView } from "../ui/minimap";
import { buildMinimapTerrain } from "../ui/minimapTerrain";
import { ObjectPanel } from "../ui/objectPanel";
import { PlayerVitals } from "../ui/playerVitals";
import { PortalDenialBanner } from "../ui/portalDenialBanner";
import { ChatBubbles } from "../world/chatBubbles";
import { CombatEffects, type DamageTone } from "../world/combatEffects";
import { drawInteractableMarkers } from "../world/interactableMarkers";
import { LocalPlayer } from "../world/localPlayer";
import { MonsterHealthBars } from "../world/monsterHealthBars";
import {
  isHeritageMonsterTexture,
  preloadHeritageMonsterArt,
  prepareHeritageMonsterArt,
  roomHasHeritageMonsters,
} from "../world/heritageMonsterArt";
import {
  MONSTER_TEXTURE,
  MonsterSprites,
  bossDisplayName,
  monsterDisplayName,
  registerMonsterAnimations,
} from "../world/monsterSprites";
import { NameTags } from "../world/nameTags";
import { drawPortalMarkers } from "../world/portalMarkers";
import { CLASSIC_VILLAGE_SOURCE, drawHeritageEnvironment, HERITAGE_AVATAR, HERITAGE_CELL, HERITAGE_ENVIRONMENT, HERITAGE_TERRAIN_SOURCE, registerHeritageTerrain, usesClassicTerrain } from "../world/heritageArt";
import { RegionGuide } from "../ui/regionGuide";
import {
  AVATAR_TEXTURE,
  AVATAR_ATTACK_TEXTURE,
  PlayerSprites,
  registerAvatarAnimations,
  STEP_TWEEN_MS,
} from "../world/playerSprites";
import { ITEM_TEXTURE, OLD_DAGGER_ITEM_KEY, WeaponVisualState, itemFrame } from "../world/weaponVisual";

/** Doubles as the loader key for the image and the tileset name embedded in every map. */
const TILESET_KEY = "plaza-tiles";
const GROUND_LAYER = "ground";
const COLLISION_LAYER = "collision";

/** Where the camera sits until the local player's sprite exists. Spawn tile per assets/README.md. */
const INITIAL_CAMERA_TILE = { tileX: 9, tileY: 11 };

export interface WorldSceneData {
  connection: RoomConnection;
}

/**
 * What `buildWorld()` keeps hold of. The tilemap must never be built twice for one room: a
 * second copy doubles the memory and, worse, carries no `setCollisionByProperty` flags, so
 * anything reading `Tile.collides` off it would call every wall walkable.
 */
interface BuiltWorld {
  map: Phaser.Tilemaps.Tilemap;
  collision: Phaser.Tilemaps.TilemapLayer;
}

/** Where the destination room should put us — the only thing a portal hop, a home hop and a landmark hop differ by. */
type Arrival =
  | { readonly kind: "portal"; readonly portalId: string }
  | { readonly kind: "home" }
  | { readonly kind: "landmark"; readonly landmarkId: string };

function joinOptionsFor(arrival: Arrival): JoinOptions {
  const identity = resolveJoinOptions();
  if (arrival.kind === "portal") {
    return { ...identity, viaPortal: arrival.portalId };
  }
  if (arrival.kind === "landmark") {
    return { ...identity, arriveAtLandmark: arrival.landmarkId };
  }
  return { ...identity, arriveAtHome: true };
}

function arrivalFailureNotice(arrival: Arrival): string {
  if (arrival.kind === "portal") {
    return "문 너머로 이동하지 못했습니다. 잠시 후 다시 지나가 보세요.";
  }
  if (arrival.kind === "landmark") {
    return "랜드마크로 이동하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "홈으로 돌아가지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export class WorldScene extends Phaser.Scene {
  static readonly KEY = "world";

  private players!: PlayerSprites;
  private monsters!: MonsterSprites;
  private monsterHealth!: MonsterHealthBars;
  private effects!: CombatEffects;
  private bubbles!: ChatBubbles;
  private nameTags!: NameTags;
  private monsterNames!: NameTags;
  private connection!: RoomConnection;
  private mapKey!: string;
  private world: BuiltWorld | null = null;
  private chat: ChatPanel | null = null;
  private homeButton: HomeButton | null = null;
  private minimap: Minimap | null = null;
  private objectPanel: ObjectPanel | null = null;
  private inventoryPanel: InventoryPanel | null = null;
  private lootTablePanel: LootTablePanel | null = null;
  private characterMenu: CharacterMenu | null = null;
  private landmarkPanel: LandmarkPanel | null = null;
  private vitals: PlayerVitals | null = null;
  private bossVitals: BossVitals | null = null;
  private toasts: ItemToasts | null = null;
  private portalDenialBanner: PortalDenialBanner | null = null;
  private localPlayer: LocalPlayer | null = null;
  private movementKeys: MovementKeys | null = null;
  private attackKey: AttackKey | null = null;
  private weapon: WeaponVisualState | null = null;
  private lastStepAt = Number.NEGATIVE_INFINITY;
  private transitioning = false;
  /**
   * True for as long as the avatar picker is reopened mid-session from the character menu
   * (`docs/design-phase-h-skin-skip-menu.md` §2.3). Unlike the bag and the drop-table window,
   * this picker is modal — it covers the stage — so movement and the home warp are blocked on
   * the same footing as `objectPanel?.blocksMovement`, for as long as it is open.
   */
  private skinPickerOpen = false;
  private regionGuide: RegionGuide | null = null;

  constructor() {
    super(WorldScene.KEY);
  }

  init(data: WorldSceneData): void {
    this.connection = data.connection;
    this.mapKey = data.connection.mapKey;
    // Phaser restarts this scene for a portal hop by re-running these hooks on the same
    // instance, so every field that outlives create() has to be cleared by hand. A surviving
    // localPlayer is the loud one: initLocalPlayer() early-returns on it, and the avatar then
    // sends its steps to the room it already left.
    this.world = null;
    this.chat = null;
    this.homeButton = null;
    this.minimap = null;
    this.objectPanel = null;
    this.inventoryPanel = null;
    this.lootTablePanel = null;
    this.characterMenu = null;
    this.landmarkPanel = null;
    this.vitals = null;
    this.bossVitals = null;
    this.toasts = null;
    this.portalDenialBanner = null;
    this.localPlayer = null;
    this.movementKeys = null;
    this.attackKey = null;
    this.weapon = null;
    this.lastStepAt = Number.NEGATIVE_INFINITY;
    this.transitioning = false;
    this.skinPickerOpen = false;
  }

  preload(): void {
    this.load.image(HERITAGE_TERRAIN_SOURCE, "/tilesets/heritage-terrain.png");
    if (usesClassicTerrain(this.mapKey)) {
      this.load.image(CLASSIC_VILLAGE_SOURCE, "/tilesets/classic-village-ground.png");
    }
    this.load.spritesheet(HERITAGE_AVATAR, "/sprites/heritage-adventurer.png", {
      frameWidth: HERITAGE_CELL, frameHeight: HERITAGE_CELL,
    });
    this.load.spritesheet(AVATAR_ATTACK_TEXTURE, "/sprites/classic-adventurer-attack.png", {
      frameWidth: HERITAGE_CELL, frameHeight: HERITAGE_CELL,
    });
    this.load.image(HERITAGE_ENVIRONMENT, "/sprites/heritage-environment.png");
    const onLoadError = (file: Phaser.Loader.File): void => {
      if (isHeritageMonsterTexture(file.key)) {
        console.warn(`Monster image unavailable: ${file.key}; using legacy art.`);
        return;
      }
      showBootError(
        "맵을 불러오지 못했습니다",
        `맵 리소스(${file.key})를 가져오지 못했습니다. 새로고침해 주세요.`,
      );
    };

    this.load.tilemapTiledJSON(this.mapKey, `/maps/${this.mapKey}.json`);
    this.load.image(TILESET_KEY, `/tilesets/${TILESET_KEY}.png`);
    this.load.spritesheet(AVATAR_TEXTURE, "/sprites/avatar.png", {
      frameWidth: TILE_SIZE_PX,
      frameHeight: TILE_SIZE_PX,
    });
    // Loaded in every room, not just the ones with spawners: the sheet is a few kilobytes, and
    // making it conditional would mean the loader has to know which rooms have monsters — a
    // second copy of a fact the server owns, and one that would fail as a blank sprite.
    this.load.spritesheet(MONSTER_TEXTURE, "/sprites/monster.png", {
      frameWidth: TILE_SIZE_PX,
      frameHeight: TILE_SIZE_PX,
    });
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onLoadError);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onLoadError);
    });
    // 지형(`usesClassicTerrain`)과 같은 게이팅. 4.32MiB를 몬스터 없는 room에 내려보내지 않는다.
    if (roomHasHeritageMonsters(this.mapKey)) {
      preloadHeritageMonsterArt(this);
    }
    // Same file the bag window already draws as a CSS background — this is a second, independent
    // loader onto a Phaser texture so the swing overlay can stamp a frame of it onto the canvas.
    this.load.spritesheet(ITEM_TEXTURE, "/sprites/items.png", {
      frameWidth: TILE_SIZE_PX,
      frameHeight: TILE_SIZE_PX,
    });
  }

  create(): void {
    try {
      this.world = this.buildWorld();
      drawPortalMarkers(this, this.connection.portalMarkers);
      drawInteractableMarkers(this, this.connection.interactableMarkers);
      registerAvatarAnimations(this);
      const monsterArt = prepareHeritageMonsterArt(this);
      registerMonsterAnimations(this, monsterArt);
      this.players = new PlayerSprites(this);
      this.monsters = new MonsterSprites(this, monsterArt);
      this.monsterHealth = new MonsterHealthBars(this);
      this.effects = new CombatEffects(this);
      this.bubbles = new ChatBubbles(this);
      this.nameTags = new NameTags(this);
      this.monsterNames = new NameTags(this);
      this.weapon = new WeaponVisualState();
    } catch (error) {
      console.error(error);
      showBootError("맵을 그리지 못했습니다", "맵 데이터가 올바르지 않습니다. 새로고침해 주세요.");
      // Returning alone leaves `update()` running against renderers this run never assigned —
      // undefined on the first boot, the previous run's destroyed objects after a portal hop —
      // which throws on every frame behind the error overlay.
      this.scene.pause();
      return;
    }

    // Revealed unconditionally (Pass F, 2026-09-02): a room with no monster in it must still show
    // an HP panel, not just one that's been attach()'d into sight of a monster.
    this.vitals = new PlayerVitals();
    this.vitals.reveal();
    // Not revealed here, unlike the panel above: a boss bar is hit-to-reveal, so a room with a
    // boss standing in it shows nothing until somebody trades a blow with it.
    this.bossVitals = new BossVitals();

    this.connection.attach({
      onPlayerAdd: (sessionId, snapshot) => this.addPlayer(sessionId, snapshot),
      onPlayerChange: (sessionId, snapshot) => this.changePlayer(sessionId, snapshot),
      onPlayerRemove: (sessionId) => {
        this.bubbles.remove(sessionId);
        this.nameTags.remove(sessionId);
        this.players.remove(sessionId);
      },
      onMonsterAdd: (monsterId, snapshot) => {
        const sprite = this.monsters.add(monsterId, snapshot);
        // A respawn reuses the id, and whatever stands there now has not been hit yet.
        this.monsterHealth.remove(monsterId);
        this.bossVitals?.release(monsterId);
        this.monsterNames.add(monsterId, sprite, monsterDisplayName(snapshot.kind));
      },
      onMonsterChange: (monsterId, snapshot) => this.monsters.update(monsterId, snapshot),
      onMonsterRemove: (monsterId) => {
        this.monsters.remove(monsterId);
        this.monsterHealth.remove(monsterId);
        // Death and walking out of the view radius arrive the same way, and a boss bar left up
        // for a boss that is no longer on screen would read as a fight still in progress.
        this.bossVitals?.release(monsterId);
        this.monsterNames.remove(monsterId);
      },
      onMonsterHit: (event) => this.showMonsterHit(event),
      onPlayerHit: (event) => this.showPlayerHit(event),
      onItemGranted: (event) => {
        this.toasts?.show(event);
        // The bag is the one window that stays open in a fight, so a pickup lands in it live
        // rather than waiting for the next read.
        this.inventoryPanel?.applyGrant(event);
      },
      onEquipmentChanged: (event) => {
        this.inventoryPanel?.applyEquipmentChange(event);
        this.weapon?.applyEquipmentChange(event);
      },
      onMoveRejected: (correction) => this.localPlayer?.applyRejection(correction),
      onTeleported: (destination) => this.localPlayer?.applyTeleport(destination),
      onChat: (message) => this.showChat(message),
      onPortalEntered: (event) => this.startHop(event.toRoom, {
        kind: "portal",
        portalId: event.portalId,
      }),
      onPortalDenied: (event) => this.portalDenialBanner?.show(event.message),
      onInteractableEntered: (event) => this.objectPanel?.open(event),
      onQuizResult: (result) => this.objectPanel?.showQuizResult(result),
      onLeave: () => {
        // Not the leave we asked for; that one never reaches here (RoomConnection.leaving).
        // This is a drop mid-hop, which leave() then early-returns on — the hop still lands, so
        // a "connection lost" modal would be a lie. abandonTransition() reports it via hasLeft,
        // and only when the hop failed too.
        if (this.transitioning) {
          return;
        }
        showBootError(
          "서버와의 연결이 끊어졌습니다",
          "네트워크 상태를 확인한 뒤 다시 시도해 주세요.",
        );
      },
      onError: (code, message) => {
        console.error(`room error ${code}: ${message ?? "unknown"}`);
      },
    });

    const connection = this.connection;
    this.chat = new ChatPanel((text) => connection.sendChat(text));
    this.homeButton = new HomeButton(() => this.returnHome());
    this.objectPanel = new ObjectPanel((objectId, choiceIndex) =>
      connection.sendQuizAnswer(objectId, choiceIndex),
    );
    this.inventoryPanel = new InventoryPanel(
      (itemKey, slot) => connection.sendEquipItem(itemKey, slot),
      (slot) => connection.sendUnequipItem(slot),
    );
    this.lootTablePanel = new LootTablePanel(this.connection.roomName);
    this.characterMenu = new CharacterMenu(() => void this.openSkinPicker());
    this.landmarkPanel = new LandmarkPanel((landmarkId) => this.warpToLandmark(landmarkId));
    this.toasts = new ItemToasts();
    this.portalDenialBanner = new PortalDenialBanner();
    this.attackKey = new AttackKey(() => this.swing());
    this.buildMinimap();
    this.regionGuide = new RegionGuide(this.mapKey);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.regionGuide?.destroy();
      this.regionGuide = null;
    });
    // attach() replays the players already in view, so addPlayer() normally does this first.
    this.initLocalPlayer();
    hideBootStatus();
    // No-op on the first boot, where the overlay is already clear; on a room hop this is the
    // far side of the wipe that hop() drew.
    void fadeFromBlack();
  }

  followTarget(target: Phaser.GameObjects.GameObject): void {
    this.cameras.main.startFollow(target, true);
  }

  override update(time: number): void {
    this.bubbles.update(time);
    this.nameTags.update();
    this.monsterNames.update();
    this.monsterHealth.update();
    // Out-of-combat recovery is drawn, never messaged (design §6.3), so it ticks here.
    this.vitals?.update();
    // Renderers, not input: these belong above the transition gate with the other two.
    this.minimap?.update(this.observeMinimap());
    const localSprite = this.players.get(this.connection.sessionId);
    if (localSprite) this.regionGuide?.update(localSprite.x, localSprite.y);

    // Behind the wipe the old room is still live; a step taken here would be applied there.
    if (this.transitioning) {
      return;
    }
    // Reading an object holds you still. There is no server-side lock behind this: the player
    // stops moving because this stops sending, which is also why the panel cannot strand anyone —
    // whatever kills the panel gives movement straight back.
    //
    // The bag and the drop-table window are deliberately *not* gated here. They are the two panels
    // that open over a live fight, and locking movement behind either would mean checking your gear
    // or drop odds is what gets you killed (docs/design-hunting-inventory.md §3.4). Attack used to
    // be swallowed while either was open; that gate is gone too (2026-09-03) — a fight in progress
    // should not stop just because a panel is up.
    if (this.objectPanel?.blocksMovement === true) {
      return;
    }
    // The re-skin picker is modal, unlike the bag and the drop-table window (design §2.3): it
    // covers the stage, so movement has to stop the same way it does behind the object panel.
    if (this.skinPickerOpen) {
      return;
    }

    const dir = this.movementKeys?.active;
    if (dir === null || dir === undefined || !this.localPlayer) {
      return;
    }
    // Paced to the render step so walking is continuous, and well clear of the
    // server's 50ms move throttle.
    if (time - this.lastStepAt < STEP_TWEEN_MS) {
      return;
    }
    this.lastStepAt = time;
    this.localPlayer.step(dir);
  }

  /**
   * Fires and forgets a {@link hop}. `catch`, not `finally`: on the success path the promise
   * settles after `scene.start`, so a `finally` would lift the gate on a run that has already
   * been replaced.
   */
  private startHop(toRoom: string, arrival: Arrival): void {
    void this.hop(toRoom, arrival).catch((error: unknown) => {
      console.error(`${arrival.kind} transition failed`, error);
      void this.abandonTransition(arrivalFailureNotice(arrival));
    });
  }

  /**
   * One swing, if the world is in a state to take one. Returns whether it was taken, which is
   * what starts the input's cooldown mirror.
   *
   * Gated on the same two things {@link returnHome} is: mid-transition, or no local player yet.
   * No open panel blocks this (2026-09-03) — the object panel, the bag, and the drop-table window
   * used to swallow Attack so a keystroke aimed at a row would not also hit whatever was standing
   * next to you, but real usage showed a panel blocking a swing mid-fight was worse than the
   * mis-click it guarded against, so that gate was dropped for all three.
   */
  private swing(): boolean {
    if (this.transitioning || !this.localPlayer) {
      return false;
    }
    this.connection.sendAttack();
    this.vitals?.beginAttackCooldown();
    // An empty swing gets no reply from the server (design §6.1), so this arc is the only proof
    // the key registered. Drawn on the predicted facing, which is what the server will read too.
    const sprite = this.players.get(this.connection.sessionId);
    if (sprite) {
      const weaponFrame = this.weapon?.hasOldDagger
        ? itemFrame(OLD_DAGGER_ITEM_KEY)
        : undefined;
      const attackPose = this.players.attack(this.connection.sessionId, this.localPlayer.facing);
      this.effects.swing(sprite, this.localPlayer.facing, weaponFrame, attackPose);
    }
    return true;
  }

  /**
   * A monster in view took a hit. Its bar appears here rather than on its arrival because this
   * message is the only thing that ever carries a monster's health (design §5.2), so a monster
   * nobody has swung at genuinely has no number to draw.
   *
   * A boss is the same trigger drawn somewhere else: the fixed top panel instead of a bar over
   * its head (`docs/design-phase-i-boss-monster.md` §10-3). Exactly one of the two ever holds a
   * given monster, so a boss never carries both readouts.
   */
  private showMonsterHit(event: MonsterHit): void {
    const sprite = this.monsters.get(event.monsterId);
    if (!sprite) {
      // The state deletion beat the message through. Nothing left on screen to draw this on.
      return;
    }
    const tone: DamageTone =
      event.bySessionId === this.connection.sessionId ? "dealt" : "dealt-by-other";
    this.effects.flash(sprite);
    this.effects.damage(sprite, event.damage, tone);
    this.effects.impact(sprite, tone);
    // The kind is only in the room state, never on this message — read from the same map the
    // sprite above came from, so the two can never disagree about what was hit.
    const bossName = bossDisplayName(this.connection.monsters.get(event.monsterId)?.kind);
    if (event.hpRemaining > 0) {
      if (bossName === null) {
        this.monsterHealth.applyHit(event.monsterId, sprite, event.hpRemaining, event.hpMax);
      } else {
        this.bossVitals?.applyHit(event.monsterId, bossName, event.hpRemaining, event.hpMax);
      }
      return;
    }
    // `hpRemaining === 0` is the death notice. Removing the sprite is not this handler's job:
    // the `state.monsters` deletion already does it, which is why the puff is a detached object.
    this.monsterHealth.remove(event.monsterId);
    this.bossVitals?.release(event.monsterId);
    this.effects.death(sprite);
  }

  /**
   * We took a hit. Unicast to the victim, so this is the only player health that exists on this
   * client — an onlooker sees the flash and no number.
   *
   * Death costs nothing but the walk home, and that walk arrives as the ordinary `Teleported`
   * this scene already handles, so there is nothing to move here.
   */
  private showPlayerHit(event: PlayerHit): void {
    this.vitals?.applyHit(event);
    const sprite = this.players.get(this.connection.sessionId);
    if (!sprite) {
      return;
    }
    const tone: DamageTone = "taken";
    this.effects.flash(sprite);
    this.effects.damage(sprite, event.damage, tone);
    this.effects.impact(sprite, tone);
    if (event.hpRemaining <= 0) {
      this.effects.death(sprite);
    }
  }

  /**
   * Takes the player home: a warp inside this room, or a hop when home is elsewhere. The client
   * is the only side that knows which room home is; the server only ever knows where a room's
   * own home tile is.
   */
  private returnHome(): void {
    // The overlay stops the mouse mid-hop but not the keyboard, and a warp into a room we are
    // leaving would be applied to a connection that is about to close.
    if (this.transitioning) {
      return;
    }
    // HomeButton owns its own window shortcut, so H fires whatever update()'s gate is doing —
    // without this the avatar warps out from under an open panel and the panel stays up.
    if (this.objectPanel?.blocksMovement === true) {
      return;
    }
    // Same reasoning, for the re-skin picker (design §2.3): without this, a home warp mid-picker
    // would restart this scene while the picker's own DOM — plain DOM outside Phaser, so the
    // restart does not touch it — is still waiting to resolve into a room that has since been
    // left, sending a skin change nobody asked for into the wrong room.
    if (this.skinPickerOpen) {
      return;
    }
    const home = resolveHomeRoomName();
    if (home === this.connection.roomName) {
      // Fire-and-forget and effectively always successful, so it stays optimistic.
      this.homeButton?.beginCooldown();
      this.connection.sendReturnHome();
      return;
    }
    // Cross-room: `hop()` starts the cooldown itself, only once the join has actually
    // succeeded — a failed hop must leave the button usable for an immediate retry.
    this.startHop(home, { kind: "home" });
  }

  /**
   * Takes the player to one of the four fixed landmarks
   * (`docs/design-phase-m-landmark-teleport.md`): a warp inside this room, or a hop when the
   * landmark is in another room. The destination room is resolved against the shared
   * `LANDMARK_DEFINITIONS` table rather than anything the panel itself carries — the same
   * "client never asserts coordinates" rule `returnHome()` already follows for home.
   */
  private warpToLandmark(landmarkId: string): void {
    if (this.transitioning) {
      return;
    }
    if (this.objectPanel?.blocksMovement === true) {
      return;
    }
    if (this.skinPickerOpen) {
      return;
    }
    let targetRoom: string | undefined;
    for (const landmark of LANDMARK_DEFINITIONS) {
      if (landmark.id === landmarkId) {
        targetRoom = landmark.room;
        break;
      }
    }
    if (targetRoom === undefined) {
      return;
    }
    if (targetRoom === this.connection.roomName) {
      // Fire-and-forget and effectively always successful, so it stays optimistic — same
      // reasoning as returnHome()'s same-room branch.
      this.landmarkPanel?.beginCooldown();
      this.connection.sendWarpToLandmark(landmarkId);
      return;
    }
    // Cross-room: `hop()` starts the cooldown itself, only once the join has actually succeeded.
    this.startHop(targetRoom, { kind: "landmark", landmarkId });
  }

  /**
   * The character menu's "스킨 변경" row: reopens the same picker BootScene runs, blocking
   * movement and the home warp for as long as it is up (`skinPickerOpen`, checked in `update()`
   * and `returnHome()`). No `destroy()`/cancel-on-scene-death is needed for this promise —
   * those two gates are what keep a room transition from ever starting while it is outstanding
   * (`docs/design-phase-h-skin-skip-menu.md` §2.3).
   *
   * A no-op pick (Escape, or re-confirming the same skin) sends nothing: nothing changed, so
   * there is nothing to broadcast or persist.
   */
  private async openSkinPicker(): Promise<void> {
    if (this.skinPickerOpen) {
      return;
    }
    const current = this.connection.players.get(this.connection.sessionId)?.avatarSkin ?? 0;
    this.skinPickerOpen = true;
    const skin = await chooseAvatarSkin(current);
    this.skinPickerOpen = false;
    if (skin === current) {
      return;
    }
    // So a later portal/home rejoin carries the new skin instead of reverting to BootScene's
    // frozen choice.
    updateAvatarSkin(skin);
    // Both sides of the split this project already draws between them: the room (live display
    // to every viewer) and the account (persisted for the next login).
    this.connection.sendChangeSkin(skin);
    saveAvatarSkin(skin);
  }

  /**
   * Moves this client to another room, whatever asked for it: a portal the server reported, or
   * the home control. Only `arrival` differs between the two, and the destination room resolves
   * it against its own config — no coordinates travel.
   *
   * Joins the destination before leaving the source: a failed join leaves the player exactly
   * where they were, whereas leaving first would strand them in no room at all with nothing to
   * recover with but a reload. Every await finishes before `scene.start`, which ends this
   * instance's current run — resuming an await afterwards would run against a dead scene.
   */
  private async hop(toRoom: string, arrival: Arrival): Promise<void> {
    // Stepping off a portal trigger and back on fires again, and the server does not care that
    // we are mid-hop. The home control is gated on the same flag. A hop that was already in
    // flight when the skin picker opened (e.g. a portal reply arriving late) must also be
    // dropped — stepping off/back on refires it once the picker closes.
    if (this.transitioning || this.skinPickerOpen) {
      return;
    }
    this.transitioning = true;
    await fadeToBlack();

    let next: RoomConnection;
    try {
      next = await RoomConnection.connect(toRoom, joinOptionsFor(arrival));
    } catch (error) {
      console.error(`failed to join room "${toRoom}" (${arrival.kind} arrival)`, error);
      await this.abandonTransition(arrivalFailureNotice(arrival));
      return;
    }
    if (arrival.kind === "home") {
      this.homeButton?.beginCooldown();
    } else if (arrival.kind === "landmark") {
      this.landmarkPanel?.beginCooldown();
    }

    await this.connection.leave();
    // Every one of these holds window/document listeners, which the scene restart does not touch.
    this.chat?.destroy();
    this.movementKeys?.destroy();
    this.attackKey?.destroy();
    this.homeButton?.destroy();
    this.minimap?.destroy();
    this.objectPanel?.destroy();
    this.inventoryPanel?.destroy();
    this.lootTablePanel?.destroy();
    this.characterMenu?.destroy();
    this.landmarkPanel?.destroy();
    this.vitals?.destroy();
    this.bossVitals?.destroy();
    this.toasts?.destroy();
    this.portalDenialBanner?.destroy();
    this.scene.start(WorldScene.KEY, { connection: next } satisfies WorldSceneData);
  }

  /**
   * Lifts the wipe and the input gate, leaving the player in the room they never left.
   *
   * The gate reopens last, after the fade and after the message is on screen. Reopening it
   * first would let a held arrow key step along a two-tile doorway and fire the next hop
   * within a frame, whose `fadeToBlack()` would clear this attempt's notice — which would then
   * be posted again over a hop that had meanwhile succeeded.
   */
  private async abandonTransition(notice: string): Promise<void> {
    await fadeFromBlack();
    if (this.connection.hasLeft) {
      // Both rooms are gone: the source dropped while the wipe was up and the hop failed too.
      // The gate stays shut on purpose — there is no live room to walk around in, and the
      // overlay's reload button is the only way out.
      showBootError("서버와의 연결이 끊어졌습니다", "네트워크 상태를 확인한 뒤 다시 시도해 주세요.");
      return;
    }
    showTransitionNotice(notice);
    this.transitioning = false;
  }

  private addPlayer(sessionId: string, snapshot: PlayerSnapshot): void {
    const sprite = this.players.add(sessionId, snapshot);
    this.nameTags.add(sessionId, sprite, snapshot.nickname);
    if (sessionId === this.connection.sessionId) {
      this.initLocalPlayer();
    }
  }

  private changePlayer(sessionId: string, snapshot: PlayerSnapshot): void {
    // Our own patches go through the predictor, which decides whether the server has
    // anything new to say; applying them directly would undo every predicted step.
    if (this.localPlayer && sessionId === this.connection.sessionId) {
      this.localPlayer.applyServerState(snapshot);
      return;
    }
    this.players.update(sessionId, snapshot);
  }

  private showChat(message: ChatBroadcast): void {
    this.chat?.append(message, message.sessionId === this.connection.sessionId);
    // Chat radius is <= view radius, so the sender is normally on screen; a sender who
    // left between sending and delivery simply gets no bubble.
    const sprite = this.players.get(message.sessionId);
    if (sprite) {
      this.bubbles.show(message.sessionId, sprite, message.text);
    }
  }

  private initLocalPlayer(): void {
    const connection = this.connection;
    if (this.localPlayer) {
      return;
    }
    const snapshot = connection.players.get(connection.sessionId);
    const sprite = this.players.get(connection.sessionId);
    if (!snapshot || !sprite) {
      return;
    }
    this.followTarget(sprite);
    this.localPlayer = new LocalPlayer(
      connection.sessionId,
      snapshot,
      this.players,
      (dir) => connection.sendMove(dir),
      (tileX, tileY) => this.isWalkable(tileX, tileY),
    );
    this.movementKeys = new MovementKeys();
  }

  /**
   * The client's own read of the map the server validated against, used to withhold steps that
   * would only come back rejected.
   *
   * The bounds test has to come first: `getTileAt` answers null both for an empty cell and for a
   * coordinate off the map, so trusting it alone would call the void outside the map walkable
   * and let the avatar stroll off the edge of the world.
   */
  private isWalkable(tileX: number, tileY: number): boolean {
    if (!this.world) {
      return false;
    }
    const { map, collision } = this.world;
    if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) {
      return false;
    }
    return collision.getTileAt(tileX, tileY)?.collides !== true;
  }

  /**
   * Minimap failures stay inside the minimap: this is a secondary view of data the world already
   * drew, so it must never raise "맵을 그리지 못했습니다" and pause a scene that is otherwise fine.
   */
  private buildMinimap(): void {
    if (!this.world) {
      return;
    }
    try {
      const terrain = buildMinimapTerrain(this.world.map, this.world.collision);
      this.minimap = new Minimap(terrain, this.connection.portalMarkers, this.mapKey);
    } catch (error) {
      console.error("minimap unavailable", error);
    }
  }

  /**
   * Reads the avatar's own sprite rather than the server snapshot or the predictor: the sprite
   * carries the step tween, so the dot moves with what is on screen instead of hopping a tile at
   * a time or trailing a patch behind. Undoes `playerSprites`' (0.5, 1) origin to get back to
   * the tile centre.
   */
  private observeMinimap(): MinimapView {
    const sprite = this.players.get(this.connection.sessionId);
    const camera = this.cameras.main.worldView;
    return {
      self: sprite ? { x: sprite.x / TILE_SIZE_PX, y: sprite.y / TILE_SIZE_PX - 0.5 } : null,
      camera: {
        x: camera.x / TILE_SIZE_PX,
        y: camera.y / TILE_SIZE_PX,
        width: camera.width / TILE_SIZE_PX,
        height: camera.height / TILE_SIZE_PX,
      },
    };
  }

  private buildWorld(): BuiltWorld {
    const map = this.make.tilemap({ key: this.mapKey });

    const terrainKey = registerHeritageTerrain(this, this.mapKey);
    const tileset = map.addTilesetImage(TILESET_KEY, terrainKey);
    if (!tileset) {
      throw new Error(`tileset "${TILESET_KEY}" is not embedded in ${this.mapKey}.json`);
    }

    // Insertion order is render order: walls and props sit above the floor.
    this.createTileLayer(map, GROUND_LAYER, tileset);
    const collision = this.createTileLayer(map, COLLISION_LAYER, tileset);
    collision.setCollisionByProperty({ collides: true });
    drawHeritageEnvironment(this, this.mapKey, collision);

    const camera = this.cameras.main;
    camera.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    camera.centerOn(
      INITIAL_CAMERA_TILE.tileX * TILE_SIZE_PX + TILE_SIZE_PX / 2,
      INITIAL_CAMERA_TILE.tileY * TILE_SIZE_PX + TILE_SIZE_PX / 2,
    );

    return { map, collision };
  }

  private createTileLayer(
    map: Phaser.Tilemaps.Tilemap,
    name: string,
    tileset: Phaser.Tilemaps.Tileset,
  ): Phaser.Tilemaps.TilemapLayer {
    const layer = map.createLayer(name, tileset, 0, 0);
    // createLayer can return the GPU variant, which has no collision API.
    if (!(layer instanceof Phaser.Tilemaps.TilemapLayer)) {
      throw new Error(`tile layer "${name}" missing from ${this.mapKey}.json`);
    }
    return layer;
  }
}
