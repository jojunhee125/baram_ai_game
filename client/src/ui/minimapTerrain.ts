import type Phaser from "phaser";

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
const FLOOR: Rgb = [58, 57, 80];
const WALL: Rgb = [20, 19, 26];

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
      paint(image.data, (y * cols + x) * 4, collision.getTileAt(x, y)?.collides ? WALL : FLOOR);
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
