import { Direction, type TilePosition } from "@zep-test/shared";
import type { CollisionMap, MovementResolver } from "../rooms/contracts";

interface TileDelta {
  dx: number;
  dy: number;
}

/** Tile rows grow downward, matching Tiled's layer data order. */
const STEP_BY_DIRECTION: Readonly<Record<Direction, TileDelta>> = {
  [Direction.Down]: { dx: 0, dy: 1 },
  [Direction.Left]: { dx: -1, dy: 0 },
  [Direction.Right]: { dx: 1, dy: 0 },
  [Direction.Up]: { dx: 0, dy: -1 },
};

/**
 * Narrows an untrusted `dir` off the wire. `resolveStep` assumes an already-valid
 * Direction, so the room handler must run this before dispatching a MoveRequest.
 */
export function isDirection(value: unknown): value is Direction {
  return typeof value === "number" && Object.hasOwn(STEP_BY_DIRECTION, value);
}

export class TileMovementResolver implements MovementResolver {
  resolveStep(from: TilePosition, dir: Direction, map: CollisionMap): TilePosition | null {
    const step = STEP_BY_DIRECTION[dir];
    const tileX = from.tileX + step.dx;
    const tileY = from.tileY + step.dy;

    if (tileX < 0 || tileY < 0 || tileX >= map.widthInTiles || tileY >= map.heightInTiles) {
      return null;
    }
    if (!map.isWalkable(tileX, tileY)) {
      return null;
    }
    return { tileX, tileY };
  }
}
