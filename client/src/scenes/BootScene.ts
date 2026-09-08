import Phaser from "phaser";
import { hideBootStatus, showBootError, showBootLoading } from "../bootStatus";
import { resolveJoinOptions, setAvatarSkin } from "../net/identity";
import { loadAvatarSkin, saveAvatarSkin } from "../net/profile";
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

    // Read while the overlay is still up, so the wait sits under "화면을 준비하는 중" rather than
    // on a blank screen. A plain HTTP request, unrelated to the room: skins are account data and
    // must not add anything to the join path.
    const loaded = await loadAvatarSkin();

    // Character select comes first and the identity is frozen by the join below, so the skin has
    // to be recorded before anything can call resolveJoinOptions().
    hideBootStatus();
    let skin: number;
    if (loaded.ok && loaded.skin !== null) {
      // A stored skin already exists (Phase H): skip the picker and go straight in with it.
      // Nothing changed from what was read, so there is nothing to save back either.
      skin = loaded.skin;
    } else {
      skin = await chooseAvatarSkin(loaded.skin ?? 0);
      // Skipped when the read itself failed (Phase C, 2026-09-03): a failure means this boot
      // never learned whether an account skin already exists, so writing here could silently
      // overwrite a real stored choice with the picker's arbitrary fallback. The session still
      // plays with the chosen skin either way — only persistence is held back.
      if (loaded.ok) {
        saveAvatarSkin(skin);
      }
    }
    setAvatarSkin(skin);

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
