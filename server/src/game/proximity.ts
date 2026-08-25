import type { TilePosition } from "@zep-test/shared";
import type { ProximityIndex } from "../rooms/contracts";

/**
 * Live view of the room's players. Satisfied by both a plain `Map<string, TilePosition>`
 * and the `MapSchema<Player>` held in RoomState, so the index reads current positions
 * instead of a snapshot taken at construction time.
 */
export interface PlayerPositions {
  entries(): Iterable<readonly [string, TilePosition]>;
}

/**
 * Chebyshev distance: the view radius has to cover the client's rectangular camera
 * viewport, and a Euclidean radius would drop the diagonal corners the camera renders.
 */
function chebyshevDistance(a: TilePosition, b: TilePosition): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

/** Phase1 O(n) scan per query. Phase2 (500 CCU) replaces this behind the same interface. */
export class NaiveProximityIndex implements ProximityIndex {
  constructor(private readonly players: PlayerPositions) {}

  within(origin: TilePosition, radiusInTiles: number): Iterable<string> {
    const found: string[] = [];
    for (const [sessionId, position] of this.players.entries()) {
      if (chebyshevDistance(origin, position) <= radiusInTiles) {
        found.push(sessionId);
      }
    }
    return found;
  }
}
