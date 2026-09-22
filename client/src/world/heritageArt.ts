import Phaser from "phaser";
import { TILE_SIZE_PX } from "@zep-test/shared";

export const HERITAGE_ENVIRONMENT = "heritage-environment";
export const HERITAGE_TERRAIN_SOURCE = "heritage-terrain-source";
export const HERITAGE_TILESET = "heritage-tiles";
export const CLASSIC_VILLAGE_SOURCE = "classic-village-ground";

export function usesClassicTerrain(mapKey: string): boolean {
  return mapKey === "plaza" || mapKey === "hunting-ground" || mapKey === "hunting-den" || mapKey === "hunting-forest";
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
  const cave = mapKey === "hunting-den";
  const forest = mapKey === "hunting-forest";
  const textureKey = forest ? "dangerous-forest-tiles" : cave ? "rock-cave-tiles" : usesClassicTerrain(mapKey) ? "classic-village-tiles" : HERITAGE_TILESET;
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
    if (forest) {
      paintForestTile(context, i);
      texture.add(i, 0, (i % 8) * 32, Math.floor(i / 8) * 32, 32, 32);
      continue;
    }
    if (cave) {
      paintCaveTile(context, i);
      texture.add(i, 0, (i % 8) * 32, Math.floor(i / 8) * 32, 32, 32);
      continue;
    }
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
    if (village && (i === 10 || i === 14)) {
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
  if (mapKey === "plaza") drawSouthGateTown(scene, collision);
  if (mapKey === "hunting-ground") {
    drawWayfinding(scene, 35.5, 8.5, "바위 사냥굴 ↑");
    drawWayfinding(scene, 35.5, 31.5, "남문 마을 ↓");
  }
  if (mapKey === "hunting-den") {
    drawWayfinding(scene, 31.5, 27.5, "초보 들판 ↓");
    drawWayfinding(scene, 46.5, 25.5, "위험한 숲 →");
  }
  if (mapKey === "hunting-forest") drawWayfinding(scene, 31.5, 27.5, "바위 사냥굴 ↓");
}

function paintForestTile(context: CanvasRenderingContext2D, tile: number): void {
  const x = (tile % 8) * TILE_SIZE_PX;
  const y = Math.floor(tile / 8) * TILE_SIZE_PX;
  const blocked = tile >= 8;
  const trail = tile === 3 || tile === 4;
  context.fillStyle = blocked ? "#1a3125" : trail ? "#776749" : "#405737";
  context.fillRect(x, y, 32, 32);
  if (blocked) {
    context.fillStyle = "#352e22";
    context.fillRect(x + 12, y + 14, 9, 18);
    context.fillRect(x + 5, y + 28, 22, 4);
    context.fillStyle = "#604b30";
    context.fillRect(x + 14, y + 17, 3, 14);
    for (const [dx, dy, width, height, color] of [
      [4, 4, 24, 16, "#294932"], [8, 0, 17, 23, "#355c3a"],
      [1, 9, 29, 10, "#36583a"], [5, 5, 10, 6, "#507244"],
      [11, 1, 9, 4, "#63804b"], [21, 10, 8, 10, "#223f2d"],
    ] as const) {
      context.fillStyle = color;
      context.fillRect(x + dx, y + dy, width, height);
    }
  } else {
    for (let i = 0; i < 16; i++) {
      context.fillStyle = trail ? (i % 2 ? "#8a7954" : "#5c513a") : (i % 2 ? "#526944" : "#30452e");
      context.fillRect(x + (i * 13 + tile * 3) % 30, y + (i * 7 + tile * 11) % 30, 2, i % 3 + 1);
    }
    if (tile === 3) {
      context.fillStyle = "#b6a077";
      for (let row = 3; row < 32; row += 8) context.fillRect(x, y + row, 32, 2);
    }
  }
}

function paintCaveTile(context: CanvasRenderingContext2D, tile: number): void {
  const x = (tile % 8) * TILE_SIZE_PX;
  const y = Math.floor(tile / 8) * TILE_SIZE_PX;
  const rock = tile >= 8;
  context.fillStyle = rock ? "#373b40" : tile === 4 || tile === 3 ? "#777367" : "#686a65";
  context.fillRect(x, y, TILE_SIZE_PX, TILE_SIZE_PX);
  if (rock) {
    const facet = (color: string, points: readonly (readonly [number, number])[]): void => {
      context.fillStyle = color;
      context.beginPath();
      points.forEach(([px, py], index) => index === 0 ? context.moveTo(x + px, y + py) : context.lineTo(x + px, y + py));
      context.closePath(); context.fill();
    };
    facet(tile === 9 ? "#626b6b" : "#596365", [[1, 10], [8, 2], [24, 1], [31, 9], [29, 25], [21, 31], [7, 28], [1, 21]]);
    facet("#7b8480", [[1, 10], [8, 2], [24, 1], [19, 7], [8, 8], [4, 16]]);
    facet("#454f56", [[19, 7], [24, 1], [31, 9], [29, 25], [21, 31], [20, 21], [25, 14]]);
    facet("#29363e", [[1, 21], [7, 28], [21, 31], [20, 26], [9, 24], [5, 19]]);
    context.fillStyle = "#85908a";
    context.fillRect(x + 10, y + 12, 5, 2);
  } else {
    for (let i = 0; i < 12; i++) {
      context.fillStyle = i % 2 === 0 ? "#777b72" : "#595e5b";
      context.fillRect(x + (i * 13 + tile * 7) % 30, y + (i * 7 + tile * 11) % 30, 2, 2);
    }
    if (tile === 1 || tile === 4) {
      context.fillStyle = "#505650";
      context.fillRect(x + 6, y + 8, 12, 2);
      context.fillRect(x + 16, y + 10, 2, 9);
      context.fillRect(x + 18, y + 17, 7, 2);
    }
    if (tile === 3) {
      context.fillStyle = "#c5b28a";
      context.fillRect(x, y + 4, 32, 3);
      context.fillRect(x, y + 25, 32, 3);
    }
  }
}

function drawSouthGateTown(scene: Phaser.Scene, collision: Phaser.Tilemaps.TilemapLayer): void {
  const art = scene.add.graphics().setDepth(1);
  const tile = TILE_SIZE_PX;
  for (const left of [18, 40]) {
    if (!blockedRectangle(collision, left, 10, 6, 3)) continue;
    const x = left * tile, y = 10 * tile, width = 6 * tile;
    art.fillStyle(0x705239).fillRect(x, y, width, 3 * tile);
    art.fillStyle(0xc4ab7b).fillRect(x + 8, y + tile, width - 16, 2 * tile - 8);
    art.fillStyle(0x393e42).fillRect(x, y, width, tile + 8);
    art.fillStyle(0x64685f).fillRect(x + 8, y + 4, width - 16, 8);
    art.fillStyle(0x272d33).fillRect(x, y + tile, width, 8);
    for (let offset = 16; offset < width; offset += 16) {
      art.fillStyle(0x85867a).fillRect(x + offset, y + 12, 3, 20);
    }
    for (const offset of [24, width - 56]) {
      art.fillStyle(0x59452f).fillRect(x + offset, y + 48, 32, 24);
      art.fillStyle(0xe0c891).fillRect(x + offset + 4, y + 52, 24, 16);
      art.fillStyle(0x59452f).fillRect(x + offset + 14, y + 52, 4, 16);
    }
    art.fillStyle(0x59452f).fillRect(x + width / 2 - 16, y + 48, 32, 48);
  }
  for (const [left, width] of [[17, 12], [35, 12]] as const) {
    if (!blockedRectangle(collision, left, 24, width, 1)) continue;
    const x = left * tile, y = 24 * tile;
    art.fillStyle(0x4a4840).fillRect(x, y, width * tile, tile);
    art.fillStyle(0xaaa28c).fillRect(x, y + 5, width * tile, 20);
    art.fillStyle(0xd0c7ab).fillRect(x, y, width * tile, 5);
    for (let offset = 0; offset < width * tile; offset += 16) {
      art.fillStyle(0x696454).fillRect(x + offset, y + 5, 2, 9);
      art.fillRect(x + offset + 8, y + 16, 2, 9);
      art.fillRect(x + offset, y + 14, 16, 2);
    }
  }
  for (const left of [26, 35]) {
    if (!blockedRectangle(collision, left, 22, 3, 3)) continue;
    const x = left * tile, y = 22 * tile;
    art.fillStyle(0x756b55).fillRect(x + 8, y + 24, 80, 72);
    art.fillStyle(0xc3b492).fillRect(x + 16, y + 32, 64, 56);
    art.fillStyle(0x3a4548).fillRect(x, y + 8, 96, 24);
    art.fillStyle(0x6c7976).fillRect(x + 8, y, 80, 12);
    art.fillStyle(0x263337).fillRect(x, y + 28, 96, 8);
    for (const offset of [24, 56]) {
      art.fillStyle(0x514333).fillRect(x + offset, y + 48, 16, 28);
      art.fillStyle(0xe1c67e).fillRect(x + offset + 4, y + 52, 8, 20);
    }
  }
  drawWayfinding(scene, 31.5, 8.5, "대광장 ↑");
  drawWayfinding(scene, 31.5, 24.4, "남문 · 초보 들판 ↓");
  drawWayfinding(scene, 35.5, 19.6, "상점");
}

function blockedRectangle(collision: Phaser.Tilemaps.TilemapLayer, x: number, y: number, width: number, height: number): boolean {
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      if (collision.getTileAt(col, row)?.collides !== true) return false;
    }
  }
  return true;
}

function drawWayfinding(scene: Phaser.Scene, tileX: number, tileY: number, label: string): void {
  scene.add.text(tileX * TILE_SIZE_PX, tileY * TILE_SIZE_PX, label, {
    fontFamily: 'Dotum, "Malgun Gothic", sans-serif', fontSize: "12px",
    color: "#f4e9cd", backgroundColor: "#352a1e", padding: { x: 8, y: 4 },
  }).setOrigin(0.5, 1).setDepth(2);
}
