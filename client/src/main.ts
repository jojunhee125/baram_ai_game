import Phaser from "phaser";
import {
  TILE_SIZE_PX,
  VIEWPORT_HEIGHT_TILES,
  VIEWPORT_WIDTH_TILES,
} from "@zep-test/shared";
import { showBootError } from "./bootStatus";
import { BootScene } from "./scenes/BootScene";
import { WorldScene } from "./scenes/WorldScene";

/*
 * Canvas size comes from shared/src/camera.ts, never from a local copy: the view radius, the
 * map border band and the .stage aspect ratio are all derived from the same two numbers, and a
 * second definition here would let them drift apart silently. 32x18 tiles = 1024x576 px.
 *
 * Scale.FIT scales that fixed backing resolution to whatever .stage measures, so the canvas
 * stays 1024x576 internally at every window size and the tile count on screen never changes.
 */
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
    // Only the first scene auto-starts; WorldScene must be started with its init data.
    scene: [BootScene, WorldScene],
  });
} catch (error) {
  console.error(error);
  showBootError(
    "화면을 시작하지 못했습니다",
    "브라우저가 게임 렌더러를 초기화하지 못했습니다. 새로고침하거나 다른 브라우저에서 열어 주세요.",
  );
}
