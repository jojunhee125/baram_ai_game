import Phaser from "phaser";
import { hideBootStatus, showBootError, showBootLoading } from "../bootStatus";
import { resolveJoinOptions, setAvatarSkin } from "../net/identity";
import { RoomConnection } from "../net/roomConnection";
import { resolveRoomName } from "../net/roomTarget";
import { chooseAvatarSkin } from "../ui/avatarPicker";
import { WorldScene, type WorldSceneData } from "./WorldScene";

/**
 * Connects before anything is drawn, because the map to load is a property of the joined
 * room (`RoomState.mapKey`) and Phaser resolves `preload()` before `create()`. Renders
 * nothing: the boot UI is the DOM overlay in `bootStatus.ts`.
 */
export class BootScene extends Phaser.Scene {
  static readonly KEY = "boot";

  constructor() {
    super(BootScene.KEY);
  }

  create(): void {
    void this.boot();
  }

  private async boot(): Promise<void> {
    const roomName = resolveRoomName();

    // Character select comes first and the identity is frozen by the join below, so the skin has
    // to be recorded before anything can call resolveJoinOptions().
    hideBootStatus();
    setAvatarSkin(await chooseAvatarSkin());

    showBootLoading("서버에 접속하는 중", "잠시만 기다려 주세요.");

    let connection: RoomConnection;
    try {
      // The same identity a room hop rejoins with, so walking through a door keeps the avatar.
      connection = await RoomConnection.connect(roomName, resolveJoinOptions());
    } catch (error) {
      console.error(`failed to join room "${roomName}"`, error);
      showBootError(
        "서버에 접속하지 못했습니다",
        "게임 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인한 뒤 다시 시도해 주세요.",
      );
      return;
    }

    showBootLoading("맵을 불러오는 중", "잠시만 기다려 주세요.");
    this.scene.start(WorldScene.KEY, { connection } satisfies WorldSceneData);
  }
}
