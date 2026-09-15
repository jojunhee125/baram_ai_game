import Phaser from "phaser";
import { TILE_SIZE_PX } from "@zep-test/shared";

export const HERITAGE_ENVIRONMENT = "heritage-environment";
export const HERITAGE_TERRAIN_SOURCE = "heritage-terrain-source";
export const HERITAGE_TILESET = "heritage-tiles";
export const CLASSIC_VILLAGE_SOURCE = "classic-village-ground";

export function usesClassicTerrain(mapKey: string): boolean {
  return mapKey === "plaza" || mapKey === "hunting-ground" || mapKey === "hunting-den";
}

const ENVIRONMENT_RECTS = [
  { x: 24, y: 100, width: 660, height: 490 },
  { x: 710, y: 100, width: 480, height: 520 },
  { x: 80, y: 830, width: 490, height: 350 },
  { x: 630, y: 690, width: 590, height: 480 },
] as const;

/** Normalize the authored 4x4 atlas into the existing Tiled 8x2 layout at load time.
 * Tile IDs and collides properties stay untouched; no server/map migration is needed. */
export function registerHeritageTerrain(scene: Phaser.Scene, mapKey = ""): string {
  const textureKey = usesClassicTerrain(mapKey) ? "classic-village-tiles" : HERITAGE_TILESET;
  if (scene.textures.exists(textureKey)) return textureKey;
  const source = scene.textures.get(HERITAGE_TERRAIN_SOURCE).getSourceImage() as HTMLImageElement;
  const village = usesClassicTerrain(mapKey)
    ? scene.textures.get(CLASSIC_VILLAGE_SOURCE).getSourceImage() as HTMLImageElement
    : null;
  const groundFrames: Readonly<Record<number, number>> = { 0: 0, 1: 0, 2: 1, 4: 2, 5: 3, 7: 1 };
  const props = scene.textures.get(HERITAGE_ENVIRONMENT).getSourceImage() as HTMLImageElement;
  const texture = scene.textures.createCanvas(textureKey, 256, 64);
  if (!texture) throw new Error("Could not create heritage terrain texture");
  const context = texture.getContext();
  context.imageSmoothingEnabled = false;
  for (let i = 0; i < 16; i++) {
    const x = Math.round((i % 4) * source.width / 4);
    const y = Math.round(Math.floor(i / 4) * source.height / 4);
    const right = Math.round(((i % 4) + 1) * source.width / 4);
    const bottom = Math.round((Math.floor(i / 4) + 1) * source.height / 4);
    const groundFrame = groundFrames[i];
    if (village && groundFrame !== undefined) {
      const cellWidth = village.width / 2;
      const cellHeight = village.height / 2;
      context.drawImage(village, (groundFrame % 2) * cellWidth, Math.floor(groundFrame / 2) * cellHeight,
        cellWidth, cellHeight, (i % 8) * 32, Math.floor(i / 8) * 32, 32, 32);
    } else {
      context.drawImage(source, x, y, right - x, bottom - y, (i % 8) * 32, Math.floor(i / 8) * 32, 32, 32);
    }
    if (village && (i === 10 || i === 14 || i === 15)) {
      context.drawImage(village, village.width / 2, 0, village.width / 2, village.height / 2,
        (i % 8) * 32, Math.floor(i / 8) * 32, 32, 32);
      const rect = ENVIRONMENT_RECTS[i === 14 ? 2 : 1];
      const scale = 30 / Math.max(rect.width, rect.height);
      const width = rect.width * scale;
      const height = rect.height * scale;
      context.drawImage(props, rect.x, rect.y, rect.width, rect.height,
        (i % 8) * 32 + (32 - width) / 2, Math.floor(i / 8) * 32 + 32 - height, width, height);
    }
    texture.add(i, 0, (i % 8) * 32, Math.floor(i / 8) * 32, 32, 32);
  }
  texture.refresh();
  return textureKey;
}

interface Decoration { frame: number; x: number; y: number; size: number }

const DECORATIONS: Readonly<Record<string, readonly Decoration[]>> = {
  plaza: [
    { frame: 0, x: 30, y: 15, size: 4 },
    { frame: 0, x: 19, y: 3, size: 5 },
    { frame: 3, x: 39, y: 3, size: 5 },
    { frame: 1, x: 14, y: 4, size: 2 },
    { frame: 1, x: 26, y: 4, size: 3 },
    { frame: 1, x: 46, y: 4, size: 3 },
  ],
  "hunting-ground": [
    { frame: 1, x: 19, y: 11, size: 2 },
    { frame: 2, x: 25, y: 11, size: 2 },
    { frame: 1, x: 31, y: 11, size: 2 },
    { frame: 1, x: 37, y: 11, size: 2 },
    { frame: 2, x: 43, y: 11, size: 2 },
    { frame: 1, x: 49, y: 11, size: 2 },
    { frame: 1, x: 22, y: 16, size: 2 },
    { frame: 2, x: 28, y: 16, size: 2 },
    { frame: 1, x: 41, y: 16, size: 2 },
    { frame: 2, x: 48, y: 16, size: 2 },
    { frame: 1, x: 54, y: 16, size: 2 },
    { frame: 1, x: 19, y: 21, size: 2 },
    { frame: 2, x: 25, y: 21, size: 2 },
    { frame: 1, x: 31, y: 21, size: 2 },
    { frame: 1, x: 37, y: 21, size: 2 },
    { frame: 2, x: 45, y: 21, size: 2 },
    { frame: 1, x: 51, y: 21, size: 2 },
    { frame: 1, x: 22, y: 26, size: 2 },
    { frame: 2, x: 28, y: 26, size: 2 },
    { frame: 1, x: 40, y: 26, size: 2 },
    { frame: 2, x: 46, y: 26, size: 2 },
    { frame: 1, x: 51, y: 26, size: 2 },
  ],
};

export function drawHeritageEnvironment(
  scene: Phaser.Scene, mapKey: string, collision: Phaser.Tilemaps.TilemapLayer,
): void {
  const atlas = scene.textures.get(HERITAGE_ENVIRONMENT);
  ENVIRONMENT_RECTS.forEach((rect, frame) => {
    if (!atlas.has(String(frame))) atlas.add(frame, 0, rect.x, rect.y, rect.width, rect.height);
  });
  for (const item of DECORATIONS[mapKey] ?? []) {
    // Check the whole drawing rectangle, not just the feet: never disguise a walkable tile
    // as a wall, cover a portal, or introduce a client-only collision rule.
    let blocked = true;
    for (let y = item.y; y < item.y + item.size; y++) {
      for (let x = item.x; x < item.x + item.size; x++) {
        if (collision.getTileAt(x, y)?.collides !== true) blocked = false;
      }
    }
    if (!blocked) continue;
    for (let y = item.y; y < item.y + item.size; y++) {
      for (let x = item.x; x < item.x + item.size; x++) {
        collision.getTileAt(x, y)!.alpha = 0;
        scene.add.image(x * TILE_SIZE_PX, y * TILE_SIZE_PX, registerHeritageTerrain(scene, mapKey), mapKey === "plaza" ? 5 : 2)
          .setOrigin(0).setDepth(0.5);
      }
    }
    const prop = scene.add.image((item.x + item.size / 2) * TILE_SIZE_PX,
      (item.y + item.size) * TILE_SIZE_PX, HERITAGE_ENVIRONMENT, item.frame);
    prop.setOrigin(0.5, 1).setScale(item.size * TILE_SIZE_PX / Math.max(prop.width, prop.height)).setDepth(1);
  }
}
