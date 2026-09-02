import Phaser from "phaser";
import {
  TILE_SIZE_PX,
  type ChatBroadcast,
  type JoinOptions,
  type MonsterHit,
  type PlayerHit,
} from "@zep-test/shared";
import { hideBootStatus, showBootError } from "../bootStatus";
import { AttackKey } from "../input/attackKey";
import { MovementKeys } from "../input/movementKeys";
import { resolveJoinOptions } from "../net/identity";
import { RoomConnection, type PlayerSnapshot } from "../net/roomConnection";
import { resolveHomeRoomName } from "../net/roomTarget";
import { fadeFromBlack, fadeToBlack, showTransitionNotice } from "../transitionOverlay";
import { ChatPanel } from "../ui/chatPanel";
import { HomeButton } from "../ui/homeButton";
import { InventoryPanel } from "../ui/inventoryPanel";
import { ItemToasts } from "../ui/itemToasts";
import { Minimap, type MinimapView } from "../ui/minimap";
import { buildMinimapTerrain } from "../ui/minimapTerrain";
import { ObjectPanel } from "../ui/objectPanel";
import { PlayerVitals } from "../ui/playerVitals";
import { ChatBubbles } from "../world/chatBubbles";
import { CombatEffects } from "../world/combatEffects";
import { drawInteractableMarkers } from "../world/interactableMarkers";
import { LocalPlayer } from "../world/localPlayer";
import { MonsterHealthBars } from "../world/monsterHealthBars";
import {
  MONSTER_TEXTURE,
  MonsterSprites,
  registerMonsterAnimations,
} from "../world/monsterSprites";
import { NameTags } from "../world/nameTags";
import { drawPortalMarkers } from "../world/portalMarkers";
import {
  AVATAR_TEXTURE,
  PlayerSprites,
  registerAvatarAnimations,
  STEP_TWEEN_MS,
} from "../world/playerSprites";

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

/** Where the destination room should put us — the only thing a portal hop and a home hop differ by. */
type Arrival = { readonly kind: "portal"; readonly portalId: string } | { readonly kind: "home" };

function joinOptionsFor(arrival: Arrival): JoinOptions {
  const identity = resolveJoinOptions();
  return arrival.kind === "portal"
    ? { ...identity, viaPortal: arrival.portalId }
    : { ...identity, arriveAtHome: true };
}

function arrivalFailureNotice(arrival: Arrival): string {
  return arrival.kind === "portal"
    ? "문 너머로 이동하지 못했습니다. 잠시 후 다시 지나가 보세요."
    : "홈으로 돌아가지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export class WorldScene extends Phaser.Scene {
  static readonly KEY = "world";

  private players!: PlayerSprites;
  private monsters!: MonsterSprites;
  private monsterHealth!: MonsterHealthBars;
  private effects!: CombatEffects;
  private bubbles!: ChatBubbles;
  private nameTags!: NameTags;
  private connection!: RoomConnection;
  private mapKey!: string;
  private world: BuiltWorld | null = null;
  private chat: ChatPanel | null = null;
  private homeButton: HomeButton | null = null;
  private minimap: Minimap | null = null;
  private objectPanel: ObjectPanel | null = null;
  private inventoryPanel: InventoryPanel | null = null;
  private vitals: PlayerVitals | null = null;
  private toasts: ItemToasts | null = null;
  private localPlayer: LocalPlayer | null = null;
  private movementKeys: MovementKeys | null = null;
  private attackKey: AttackKey | null = null;
  private lastStepAt = Number.NEGATIVE_INFINITY;
  private transitioning = false;

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
    this.vitals = null;
    this.toasts = null;
    this.localPlayer = null;
    this.movementKeys = null;
    this.attackKey = null;
    this.lastStepAt = Number.NEGATIVE_INFINITY;
    this.transitioning = false;
  }

  preload(): void {
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      showBootError(
        "맵을 불러오지 못했습니다",
        `맵 리소스(${file.key})를 가져오지 못했습니다. 새로고침해 주세요.`,
      );
    });

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
  }

  create(): void {
    try {
      this.world = this.buildWorld();
      drawPortalMarkers(this, this.connection.portalMarkers);
      drawInteractableMarkers(this, this.connection.interactableMarkers);
      registerAvatarAnimations(this);
      registerMonsterAnimations(this);
      this.players = new PlayerSprites(this);
      this.monsters = new MonsterSprites(this);
      this.monsterHealth = new MonsterHealthBars(this);
      this.effects = new CombatEffects(this);
      this.bubbles = new ChatBubbles(this);
      this.nameTags = new NameTags(this);
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

    this.connection.attach({
      onPlayerAdd: (sessionId, snapshot) => this.addPlayer(sessionId, snapshot),
      onPlayerChange: (sessionId, snapshot) => this.changePlayer(sessionId, snapshot),
      onPlayerRemove: (sessionId) => {
        this.bubbles.remove(sessionId);
        this.nameTags.remove(sessionId);
        this.players.remove(sessionId);
      },
      onMonsterAdd: (monsterId, snapshot) => {
        this.monsters.add(monsterId, snapshot);
        // A respawn reuses the id, and whatever stands there now has not been hit yet.
        this.monsterHealth.remove(monsterId);
      },
      onMonsterChange: (monsterId, snapshot) => this.monsters.update(monsterId, snapshot),
      onMonsterRemove: (monsterId) => {
        this.monsters.remove(monsterId);
        this.monsterHealth.remove(monsterId);
      },
      onMonsterHit: (event) => this.showMonsterHit(event),
      onPlayerHit: (event) => this.showPlayerHit(event),
      onItemGranted: (event) => {
        this.toasts?.show(event);
        // The bag is the one window that stays open in a fight, so a pickup lands in it live
        // rather than waiting for the next read.
        this.inventoryPanel?.applyGrant(event);
      },
      onMoveRejected: (correction) => this.localPlayer?.applyRejection(correction),
      onTeleported: (destination) => this.localPlayer?.applyTeleport(destination),
      onChat: (message) => this.showChat(message),
      onPortalEntered: (event) => this.startHop(event.toRoom, {
        kind: "portal",
        portalId: event.portalId,
      }),
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
    this.inventoryPanel = new InventoryPanel();
    this.toasts = new ItemToasts();
    this.attackKey = new AttackKey(() => this.swing());
    this.buildMinimap();
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
    this.monsterHealth.update();
    // Out-of-combat recovery is drawn, never messaged (design §6.3), so it ticks here.
    this.vitals?.update();
    // Renderers, not input: these belong above the transition gate with the other two.
    this.minimap?.update(this.observeMinimap());

    // Behind the wipe the old room is still live; a step taken here would be applied there.
    if (this.transitioning) {
      return;
    }
    // Reading an object holds you still. There is no server-side lock behind this: the player
    // stops moving because this stops sending, which is also why the panel cannot strand anyone —
    // whatever kills the panel gives movement straight back.
    //
    // The bag is deliberately *not* gated here. It is the one panel that opens over a live fight,
    // and locking movement behind it would mean checking your bag is what gets you killed
    // (docs/design-hunting-inventory.md §3.4). Pass E's Attack input is the one thing it does
    // swallow, and reads `inventoryPanel.isOpen` from wherever that input lands.
    if (this.objectPanel?.isOpen === true) {
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
   * Gated on the same two things {@link returnHome} is, plus the bag. The bag deliberately never
   * blocks movement — being pinned in place while something chews on you is exactly what that
   * decision avoids (`docs/design-hunting-inventory.md` §3.4) — but it does swallow this, because
   * a keystroke aimed at a bag row must not also hit whatever is standing next to you.
   */
  private swing(): boolean {
    if (this.transitioning || !this.localPlayer) {
      return false;
    }
    if (this.objectPanel?.isOpen === true || this.inventoryPanel?.isOpen === true) {
      return false;
    }
    this.connection.sendAttack();
    this.vitals?.beginAttackCooldown();
    // An empty swing gets no reply from the server (design §6.1), so this arc is the only proof
    // the key registered. Drawn on the predicted facing, which is what the server will read too.
    const sprite = this.players.get(this.connection.sessionId);
    if (sprite) {
      this.effects.swing(sprite, this.localPlayer.facing);
    }
    return true;
  }

  /**
   * A monster in view took a hit. Its bar appears here rather than on its arrival because this
   * message is the only thing that ever carries a monster's health (design §5.2), so a monster
   * nobody has swung at genuinely has no number to draw.
   */
  private showMonsterHit(event: MonsterHit): void {
    const sprite = this.monsters.get(event.monsterId);
    if (!sprite) {
      // The state deletion beat the message through. Nothing left on screen to draw this on.
      return;
    }
    this.effects.flash(sprite);
    this.effects.damage(
      sprite,
      event.damage,
      event.bySessionId === this.connection.sessionId ? "dealt" : "dealt-by-other",
    );
    if (event.hpRemaining > 0) {
      this.monsterHealth.applyHit(event.monsterId, sprite, event.hpRemaining, event.hpMax);
      return;
    }
    // `hpRemaining === 0` is the death notice. Removing the sprite is not this handler's job:
    // the `state.monsters` deletion already does it, which is why the puff is a detached object.
    this.monsterHealth.remove(event.monsterId);
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
    this.effects.flash(sprite);
    this.effects.damage(sprite, event.damage, "taken");
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
    if (this.objectPanel?.isOpen === true) {
      return;
    }
    const home = resolveHomeRoomName();
    this.homeButton?.beginCooldown();
    if (home === this.connection.roomName) {
      this.connection.sendReturnHome();
      return;
    }
    this.startHop(home, { kind: "home" });
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
    // we are mid-hop. The home control is gated on the same flag.
    if (this.transitioning) {
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

    await this.connection.leave();
    // Every one of these holds window/document listeners, which the scene restart does not touch.
    this.chat?.destroy();
    this.movementKeys?.destroy();
    this.attackKey?.destroy();
    this.homeButton?.destroy();
    this.minimap?.destroy();
    this.objectPanel?.destroy();
    this.inventoryPanel?.destroy();
    this.vitals?.destroy();
    this.toasts?.destroy();
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

    const tileset = map.addTilesetImage(TILESET_KEY, TILESET_KEY);
    if (!tileset) {
      throw new Error(`tileset "${TILESET_KEY}" is not embedded in ${this.mapKey}.json`);
    }

    // Insertion order is render order: walls and props sit above the floor.
    this.createTileLayer(map, GROUND_LAYER, tileset);
    const collision = this.createTileLayer(map, COLLISION_LAYER, tileset);
    collision.setCollisionByProperty({ collides: true });

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
