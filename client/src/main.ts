import Phaser from "phaser";
import { TILE_SIZE_PX } from "@zep-test/shared";
import { showBootError } from "./bootStatus";
import { WorldScene } from "./scenes/WorldScene";

/** Visible area in tiles. Independent of map size — the camera clamps to the map bounds. */
const VIEWPORT_WIDTH_TILES = 20;
const VIEWPORT_HEIGHT_TILES = 15;

try {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game-root",
    width: VIEWPORT_WIDTH_TILES * TILE_SIZE_PX,
    height: VIEWPORT_HEIGHT_TILES * TILE_SIZE_PX,
    pixelArt: true,
    backgroundColor: "#14131a",
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [WorldScene],
  });
} catch (error) {
  console.error(error);
  showBootError(
    "화면을 시작하지 못했습니다",
    "브라우저가 게임 렌더러를 초기화하지 못했습니다. 새로고침하거나 다른 브라우저에서 열어 주세요.",
  );
}
