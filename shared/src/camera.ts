/**
 * Camera geometry. The single source for "how much world is on screen", which four other
 * places are derived from and must never restate independently:
 *
 *   1. `client/src/main.ts`      - the Phaser canvas size (tiles * TILE_SIZE_PX)
 *   2. `shared/src/constants.ts` - VIEW_RADIUS_TILES / CHAT_RADIUS_TILES
 *   3. `tools/generate-*.mjs`    - the non-walkable border band baked into each map
 *   4. `client/src/style.css`    - the .stage aspect ratio
 *
 * Sizing rationale (which window sizes stay above 1x pixel scale, why 16:9) is recorded in
 * `docs/decisions.md` 2026-08-27 "새 뷰포트 타일 수 확정" - not repeated here.
 */

/** Visible area in tiles. 32x18 = 16:9 exactly, so the canvas is 1024x576 px. */
export const VIEWPORT_WIDTH_TILES = 32;
export const VIEWPORT_HEIGHT_TILES = 18;

/**
 * Thickness, in tiles, of the non-walkable band a map needs on each side so the camera never
 * hits its own `setBounds` clamp while a player stands on a walkable tile. While the band holds
 * no walkable tile the local player is always exactly screen-centred, and only then is
 * `maxVisibleTileDistance` (and therefore VIEW_RADIUS_TILES) a true upper bound.
 */
export interface CameraBorderTiles {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The camera centres on the avatar's origin - `(tileX + 0.5, tileY + 1)` in tile units, because
 * the sprite origin is `(0.5, 1)`, its tile's bottom edge. That half-tile downward offset is why
 * `bottom` is one thicker than `top` on an even-height viewport, and it is not a rounding
 * artefact: a map generated with a symmetric band lets the camera clamp along the south edge.
 *
 * A tile counts as visible when the camera rectangle overlaps it with positive area, so a column
 * or row that is only half on screen still counts.
 *
 * Reproduces the two values the project has already measured:
 *   20x15 (pre-2026-08-27) -> { left: 10, right: 10, top: 7, bottom: 8 }  = generate-load-map BORDER
 *   32x18 (current)        -> { left: 16, right: 16, top: 8, bottom: 9 }
 */
export function cameraBorderTiles(
  widthInTiles: number,
  heightInTiles: number,
): CameraBorderTiles {
  const horizontal = Math.ceil((widthInTiles + 1) / 2) - 1;
  return {
    left: horizontal,
    right: horizontal,
    top: Math.ceil(heightInTiles / 2) - 1,
    bottom: Math.floor((heightInTiles + 1) / 2),
  };
}

/**
 * Furthest Chebyshev distance at which another player's tile can still put a pixel on screen,
 * given the camera never clamps. The lower bound for VIEW_RADIUS_TILES: anything below this and
 * a player pops in while already visible.
 *
 *   20x15 -> 10   (matches docs/poc2-design.md §2.2)
 *   32x18 -> 16
 */
export function maxVisibleTileDistance(
  widthInTiles: number,
  heightInTiles: number,
): number {
  const border = cameraBorderTiles(widthInTiles, heightInTiles);
  return Math.max(border.left, border.right, border.top, border.bottom);
}
