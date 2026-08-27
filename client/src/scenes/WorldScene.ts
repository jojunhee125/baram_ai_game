import Phaser from "phaser";
import { TILE_SIZE_PX, type ChatBroadcast, type PortalEntered } from "@zep-test/shared";
import { hideBootStatus, showBootError } from "../bootStatus";
import { MovementKeys } from "../input/movementKeys";
import { resolveJoinOptions } from "../net/identity";
import { RoomConnection, type PlayerSnapshot } from "../net/roomConnection";
import { fadeFromBlack, fadeToBlack, showTransitionNotice } from "../transitionOverlay";
import { ChatPanel } from "../ui/chatPanel";
import { ChatBubbles } from "../world/chatBubbles";
import { LocalPlayer } from "../world/localPlayer";
import { NameTags } from "../world/nameTags";
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

export class WorldScene extends Phaser.Scene {
  static readonly KEY = "world";

  private players!: PlayerSprites;
  private bubbles!: ChatBubbles;
  private nameTags!: NameTags;
  private connection!: RoomConnection;
  private mapKey!: string;
  private chat: ChatPanel | null = null;
  private localPlayer: LocalPlayer | null = null;
  private movementKeys: MovementKeys | null = null;
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
    this.chat = null;
    this.localPlayer = null;
    this.movementKeys = null;
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
  }

  create(): void {
    try {
      this.buildWorld();
      registerAvatarAnimations(this);
      this.players = new PlayerSprites(this);
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

    this.connection.attach({
      onPlayerAdd: (sessionId, snapshot) => this.addPlayer(sessionId, snapshot),
      onPlayerChange: (sessionId, snapshot) => this.changePlayer(sessionId, snapshot),
      onPlayerRemove: (sessionId) => {
        this.bubbles.remove(sessionId);
        this.nameTags.remove(sessionId);
        this.players.remove(sessionId);
      },
      onMoveRejected: (correction) => this.localPlayer?.applyRejection(correction),
      onChat: (message) => this.showChat(message),
      onPortalEntered: (event) => {
        // `catch`, not `finally`: on the success path this promise settles after `scene.start`,
        // so a `finally` would lift the gate on a run that has already been replaced.
        void this.transitionTo(event).catch((error: unknown) => {
          console.error("portal transition failed", error);
          void this.abandonTransition();
        });
      },
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
    // attach() replays the players already in view, so addPlayer() normally does this first.
    this.initLocalPlayer();
    hideBootStatus();
    // No-op on the first boot, where the overlay is already clear; on a portal hop this is the
    // far side of the wipe that transitionTo() drew.
    void fadeFromBlack();
  }

  followTarget(target: Phaser.GameObjects.GameObject): void {
    this.cameras.main.startFollow(target, true);
  }

  override update(time: number): void {
    this.bubbles.update(time);
    this.nameTags.update();

    // Behind the wipe the old room is still live; a step taken here would be applied there.
    if (this.transitioning) {
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
   * Joins the destination before leaving the source: a failed join leaves the player exactly
   * where they were, whereas leaving first would strand them in no room at all with nothing to
   * recover with but a reload. Every await finishes before `scene.start`, which ends this
   * instance's current run — resuming an await afterwards would run against a dead scene.
   */
  private async transitionTo({ portalId, toRoom }: PortalEntered): Promise<void> {
    // Stepping off the trigger and back on fires again, and the server does not care that we
    // are mid-hop.
    if (this.transitioning) {
      return;
    }
    this.transitioning = true;
    await fadeToBlack();

    let next: RoomConnection;
    try {
      next = await RoomConnection.connect(toRoom, {
        ...resolveJoinOptions(),
        viaPortal: portalId,
      });
    } catch (error) {
      console.error(`failed to join room "${toRoom}" through portal "${portalId}"`, error);
      await this.abandonTransition();
      return;
    }

    await this.connection.leave();
    // Both hold window/document listeners, which the scene restart does not touch.
    this.chat?.destroy();
    this.movementKeys?.destroy();
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
  private async abandonTransition(): Promise<void> {
    await fadeFromBlack();
    if (this.connection.hasLeft) {
      // Both rooms are gone: the source dropped while the wipe was up and the hop failed too.
      // The gate stays shut on purpose — there is no live room to walk around in, and the
      // overlay's reload button is the only way out.
      showBootError("서버와의 연결이 끊어졌습니다", "네트워크 상태를 확인한 뒤 다시 시도해 주세요.");
      return;
    }
    showTransitionNotice("문 너머로 이동하지 못했습니다. 잠시 후 다시 지나가 보세요.");
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
    this.localPlayer = new LocalPlayer(connection.sessionId, snapshot, this.players, (dir) =>
      connection.sendMove(dir),
    );
    this.movementKeys = new MovementKeys();
  }

  private buildWorld(): void {
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
