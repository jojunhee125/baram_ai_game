import Phaser from "phaser";
import { TILE_SIZE_PX, type ChatBroadcast } from "@zep-test/shared";
import { hideBootStatus, showBootError, showBootLoading } from "../bootStatus";
import { MovementKeys } from "../input/movementKeys";
import { RoomConnection, type PlayerSnapshot } from "../net/roomConnection";
import { ChatPanel } from "../ui/chatPanel";
import { ChatBubbles } from "../world/chatBubbles";
import { LocalPlayer } from "../world/localPlayer";
import {
  AVATAR_TEXTURE,
  PlayerSprites,
  registerAvatarAnimations,
  STEP_TWEEN_MS,
} from "../world/playerSprites";

const MAP_KEY = "plaza";
/** Doubles as the loader key for the image and the tileset name embedded in plaza.json. */
const TILESET_KEY = "plaza-tiles";
const GROUND_LAYER = "ground";
const COLLISION_LAYER = "collision";

/** Where the camera sits until the local player's sprite exists. Spawn tile per assets/README.md. */
const INITIAL_CAMERA_TILE = { tileX: 9, tileY: 11 };

export class WorldScene extends Phaser.Scene {
  static readonly KEY = "world";

  private players!: PlayerSprites;
  private bubbles!: ChatBubbles;
  private connection: RoomConnection | null = null;
  private chat: ChatPanel | null = null;
  private localPlayer: LocalPlayer | null = null;
  private movementKeys: MovementKeys | null = null;
  private lastStepAt = Number.NEGATIVE_INFINITY;

  constructor() {
    super(WorldScene.KEY);
  }

  preload(): void {
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      showBootError(
        "맵을 불러오지 못했습니다",
        `맵 리소스(${file.key})를 가져오지 못했습니다. 새로고침해 주세요.`,
      );
    });

    this.load.tilemapTiledJSON(MAP_KEY, `/maps/${MAP_KEY}.json`);
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
    } catch (error) {
      console.error(error);
      showBootError("맵을 그리지 못했습니다", "맵 데이터가 올바르지 않습니다. 새로고침해 주세요.");
      return;
    }

    void this.connectToRoom();
  }

  followTarget(target: Phaser.GameObjects.GameObject): void {
    this.cameras.main.startFollow(target, true);
  }

  private async connectToRoom(): Promise<void> {
    showBootLoading("서버에 접속하는 중", "잠시만 기다려 주세요.");
    try {
      this.connection = await RoomConnection.connect({
        onPlayerAdd: (sessionId, snapshot) => this.addPlayer(sessionId, snapshot),
        onPlayerChange: (sessionId, snapshot) => this.changePlayer(sessionId, snapshot),
        onPlayerRemove: (sessionId) => {
          this.bubbles.remove(sessionId);
          this.players.remove(sessionId);
        },
        onMoveRejected: (correction) => this.localPlayer?.applyRejection(correction),
        onChat: (message) => this.showChat(message),
        onLeave: () => {
          showBootError(
            "서버와의 연결이 끊어졌습니다",
            "네트워크 상태를 확인한 뒤 다시 시도해 주세요.",
          );
        },
        onError: (code, message) => {
          console.error(`room error ${code}: ${message ?? "unknown"}`);
        },
      });
      // The local player's onPlayerAdd can land on either side of this await, so setup
      // is attempted from both here and addPlayer().
      this.initLocalPlayer();
      const connection = this.connection;
      this.chat = new ChatPanel((text) => connection.sendChat(text));
      hideBootStatus();
    } catch (error) {
      console.error(error);
      showBootError(
        "서버에 접속하지 못했습니다",
        "게임 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인한 뒤 다시 시도해 주세요.",
      );
    }
  }

  override update(time: number): void {
    this.bubbles.update(time);

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

  private addPlayer(sessionId: string, snapshot: PlayerSnapshot): void {
    this.players.add(sessionId, snapshot);
    if (sessionId === this.connection?.sessionId) {
      this.initLocalPlayer();
    }
  }

  private changePlayer(sessionId: string, snapshot: PlayerSnapshot): void {
    // Our own patches go through the predictor, which decides whether the server has
    // anything new to say; applying them directly would undo every predicted step.
    if (this.localPlayer && sessionId === this.connection?.sessionId) {
      this.localPlayer.applyServerState(snapshot);
      return;
    }
    this.players.update(sessionId, snapshot);
  }

  private showChat(message: ChatBroadcast): void {
    this.chat?.append(message, message.sessionId === this.connection?.sessionId);
    // Chat radius is <= view radius, so the sender is normally on screen; a sender who
    // left between sending and delivery simply gets no bubble.
    const sprite = this.players.get(message.sessionId);
    if (sprite) {
      this.bubbles.show(message.sessionId, sprite, message.text);
    }
  }

  private initLocalPlayer(): void {
    const connection = this.connection;
    if (!connection || this.localPlayer) {
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
    const map = this.make.tilemap({ key: MAP_KEY });

    const tileset = map.addTilesetImage(TILESET_KEY, TILESET_KEY);
    if (!tileset) {
      throw new Error(`tileset "${TILESET_KEY}" is not embedded in ${MAP_KEY}.json`);
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
      throw new Error(`tile layer "${name}" missing from ${MAP_KEY}.json`);
    }
    return layer;
  }
}
