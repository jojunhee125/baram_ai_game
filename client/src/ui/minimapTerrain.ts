import type Phaser from "phaser";
import { progressionMinimapColor } from "../world/progressionTerrain";

/** One map baked at one pixel per tile. Immutable for the room's lifetime. */
export interface MinimapTerrain {
  cols: number;
  rows: number;
  buffer: HTMLCanvasElement;
}

type Rgb = readonly [number, number, number];

/*
 * Fixed in both colour schemes, like the in-world portal pad and the chat panel: this sits on
 * the game canvas, which is the same pixel art whatever the OS theme says.
 */
const FLOOR: Rgb = [114, 106, 77];
const WALL: Rgb = [48, 46, 39];
const GRASS: Rgb = [86, 109, 58];
const ROAD: Rgb = [158, 136, 92];
const CAVE_FLOOR: Rgb = [116, 119, 109];
const CAVE_WALL: Rgb = [48, 57, 65];

/**
 * Bakes the whole map into an offscreen canvas, one pixel per tile. Once per room.
 *
 * Walkability comes from `Tile.collides` on the layer `buildWorld()` already ran
 * `setCollisionByProperty` over — never from `gid !== 0`. `assets/README.md` warns about exactly
 * this: walkable decoration does live on the collision layer, so reading gids would paint open
 * ground as wall and the minimap would show a route that does not exist.
 *
 * Portals are not baked in. One pixel per tile is enough for terrain, whose meaning survives
 * being a smudge, but not for an exit: on grand-plaza a door would be a 2px speck nobody finds.
 * `minimap.ts` draws them at a fixed pixel size instead.
 *
 * @param collision the layer `buildWorld()` built; rebuilding it here would drop its collision flags
 */
export function buildMinimapTerrain(
  map: Phaser.Tilemaps.Tilemap,
  collision: Phaser.Tilemaps.TilemapLayer,
  mapKey = "",
): MinimapTerrain {
  const cols = map.width;
  const rows = map.height;

  const buffer = document.createElement("canvas");
  buffer.width = cols;
  buffer.height = rows;

  const context = buffer.getContext("2d");
  if (!context) {
    throw new Error("could not get a 2d context for the minimap terrain buffer");
  }

  const image = context.createImageData(cols, rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const blocked = collision.getTileAt(x, y)?.collides === true;
      const ground = map.getTileAt(x, y, false, "ground")?.index;
      const color = progressionMinimapColor(mapKey, blocked, ground) ?? (mapKey === "hunting-den" ? (blocked ? CAVE_WALL : CAVE_FLOOR)
        : mapKey === "hunting-forest" ? (blocked ? [26, 49, 37] as const : ground === 4 || ground === 5 ? ROAD : [65, 90, 55] as const)
        : blocked ? WALL : ground === 3 || ground === 8 ? GRASS : ground === 4 || ground === 5 ? ROAD : FLOOR);
      paint(image.data, (y * cols + x) * 4, color);
    }
  }
  context.putImageData(image, 0, 0);

  return { cols, rows, buffer };
}

function paint(data: Uint8ClampedArray, at: number, [r, g, b]: Rgb): void {
  data[at] = r;
  data[at + 1] = g;
  data[at + 2] = b;
  data[at + 3] = 255;
}
