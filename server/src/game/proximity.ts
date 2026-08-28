import type { TilePosition } from "@zep-test/shared";
import type { ProximityIndex } from "../rooms/contracts";

/**
 * Chebyshev distance: the view radius has to cover the client's rectangular camera
 * viewport, and a Euclidean radius would drop the diagonal corners the camera renders.
 */
export function chebyshevDistance(a: TilePosition, b: TilePosition): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

/** The index's own position copy, rewritten in place by `move()` so stepping allocates nothing. */
interface StoredPosition {
  tileX: number;
  tileY: number;
}

/**
 * Uniform grid (spatial hashing) over the tile map: every player sits in exactly one cell,
 * and a radius query only visits the cells the query square overlaps.
 *
 * It fits this room better than a tree because the three things a tree buys — adaptivity to
 * clustering, unbounded coordinates, arbitrary query shapes — are all things the room does
 * not have. Coordinates are a bounded integer grid, the query radius is a constant, and a
 * step is one tile, so updates are O(1) with no rebalancing at all.
 *
 * Pick `cellSizeInTiles` to be the largest radius the caller ever queries plus one: that is
 * the smallest cell for which the query square spans only 3x3 cells. A caller that sometimes
 * queries wider — the room's home warp does — still gets exact answers, it just pays the cells
 * that wider square covers.
 */
export class UniformGridProximityIndex implements ProximityIndex {
  private readonly cellCountX: number;
  private readonly cellCountY: number;
  private readonly cells: Array<Set<string>>;
  private readonly cellOf = new Map<string, number>();
  private readonly positions = new Map<string, StoredPosition>();

  constructor(
    widthInTiles: number,
    heightInTiles: number,
    private readonly cellSizeInTiles: number,
  ) {
    this.cellCountX = Math.max(1, Math.ceil(widthInTiles / cellSizeInTiles));
    this.cellCountY = Math.max(1, Math.ceil(heightInTiles / cellSizeInTiles));
    // Every cell exists up front: a dense array of Sets skips the hashing and the growth
    // that a keyed Map would pay on the hot query path.
    this.cells = Array.from(
      { length: this.cellCountX * this.cellCountY },
      () => new Set<string>(),
    );
  }

  within(origin: TilePosition, radiusInTiles: number, out: string[]): string[] {
    out.length = 0;
    if (radiusInTiles < 0) {
      return out;
    }

    const minCellX = this.clampCellX(this.cellAxis(origin.tileX - radiusInTiles));
    const maxCellX = this.clampCellX(this.cellAxis(origin.tileX + radiusInTiles));
    const minCellY = this.clampCellY(this.cellAxis(origin.tileY - radiusInTiles));
    const maxCellY = this.clampCellY(this.cellAxis(origin.tileY + radiusInTiles));

    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      const rowBase = cellY * this.cellCountX;
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const cell = this.cells[rowBase + cellX];
        if (cell === undefined) {
          continue;
        }
        for (const sessionId of cell) {
          const position = this.positions.get(sessionId);
          if (position === undefined) {
            continue;
          }
          if (
            Math.abs(position.tileX - origin.tileX) <= radiusInTiles &&
            Math.abs(position.tileY - origin.tileY) <= radiusInTiles
          ) {
            out.push(sessionId);
          }
        }
      }
    }
    return out;
  }

  insert(sessionId: string, position: TilePosition): void {
    const cellIndex = this.cellIndexOf(position.tileX, position.tileY);
    this.positions.set(sessionId, { tileX: position.tileX, tileY: position.tileY });
    this.cellOf.set(sessionId, cellIndex);
    this.cells[cellIndex]?.add(sessionId);
  }

  move(sessionId: string, position: TilePosition): void {
    const stored = this.positions.get(sessionId);
    if (stored === undefined) {
      return;
    }
    stored.tileX = position.tileX;
    stored.tileY = position.tileY;

    // A one-tile step crosses a cell boundary about 2/cellSize of the time, so most moves
    // stop here and never touch the Sets.
    const nextCell = this.cellIndexOf(position.tileX, position.tileY);
    const currentCell = this.cellOf.get(sessionId);
    if (nextCell === currentCell) {
      return;
    }
    if (currentCell !== undefined) {
      this.cells[currentCell]?.delete(sessionId);
    }
    this.cellOf.set(sessionId, nextCell);
    this.cells[nextCell]?.add(sessionId);
  }

  remove(sessionId: string): void {
    const cellIndex = this.cellOf.get(sessionId);
    if (cellIndex !== undefined) {
      this.cells[cellIndex]?.delete(sessionId);
    }
    this.cellOf.delete(sessionId);
    this.positions.delete(sessionId);
  }

  /**
   * Math.floor, never `| 0` or Math.trunc: those round towards zero, so every tile in the
   * strip left of or above the map would map to cell 0 rather than to a negative index.
   * The clamp in the callers happens to absorb that today; it stops absorbing it the moment
   * the grid no longer starts at tile 0.
   */
  private cellAxis(tile: number): number {
    return Math.floor(tile / this.cellSizeInTiles);
  }

  private clampCellX(cellX: number): number {
    return cellX < 0 ? 0 : cellX > this.cellCountX - 1 ? this.cellCountX - 1 : cellX;
  }

  private clampCellY(cellY: number): number {
    return cellY < 0 ? 0 : cellY > this.cellCountY - 1 ? this.cellCountY - 1 : cellY;
  }

  private cellIndexOf(tileX: number, tileY: number): number {
    const cellX = this.clampCellX(this.cellAxis(tileX));
    const cellY = this.clampCellY(this.cellAxis(tileY));
    return cellY * this.cellCountX + cellX;
  }
}

/**
 * Reference implementation / test oracle — do not use on the production path. It answers
 * every query with a full scan, which is exactly what makes it useful: it has no cells,
 * no clamping and no invalidation, so the differential test can trust it to say what
 * {@link UniformGridProximityIndex} should have said.
 */
export class NaiveProximityIndex implements ProximityIndex {
  private readonly positions = new Map<string, StoredPosition>();

  within(origin: TilePosition, radiusInTiles: number, out: string[]): string[] {
    out.length = 0;
    for (const [sessionId, position] of this.positions) {
      if (chebyshevDistance(origin, position) <= radiusInTiles) {
        out.push(sessionId);
      }
    }
    return out;
  }

  insert(sessionId: string, position: TilePosition): void {
    this.positions.set(sessionId, { tileX: position.tileX, tileY: position.tileY });
  }

  move(sessionId: string, position: TilePosition): void {
    const stored = this.positions.get(sessionId);
    if (stored === undefined) {
      return;
    }
    stored.tileX = position.tileX;
    stored.tileY = position.tileY;
  }

  remove(sessionId: string): void {
    this.positions.delete(sessionId);
  }
}
