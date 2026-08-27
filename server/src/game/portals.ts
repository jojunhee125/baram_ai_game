import type {
  CollisionMap,
  PortalDefinition,
  PortalIndex,
  SpawnArea,
} from "../rooms/contracts";

/**
 * {@link PortalIndex} over {@link PortalDefinition} rows, narrowed to one room at construction.
 *
 * Trigger lookup keys on the same linear index the collision grid uses
 * (`tileY * widthInTiles + tileX`) rather than on a `"x,y"` string: `triggerAt` runs on every
 * accepted move, and a key built per move is exactly the young-gen garbage the room's scratch
 * buffers exist to avoid.
 */
export class TablePortalIndex implements PortalIndex {
  private readonly triggers = new Map<number, PortalDefinition>();
  private readonly arrivals = new Map<string, SpawnArea>();
  private readonly widthInTiles: number;

  /**
   * `roomName` is `string | undefined` because a room built without the matchmaker — which is
   * how the view tests build one — has no `roomName` at runtime even though Colyseus types it
   * as `string`. Undefined simply matches no row, leaving an index that answers null.
   */
  constructor(
    roomName: string | undefined,
    portals: readonly PortalDefinition[],
    map: CollisionMap,
  ) {
    this.widthInTiles = map.widthInTiles;
    if (roomName === undefined) {
      return;
    }
    for (const portal of portals) {
      if (portal.from.room === roomName) {
        for (const tile of portal.from.tiles) {
          this.triggers.set(tile.tileY * this.widthInTiles + tile.tileX, portal);
        }
      }
      if (portal.to.room === roomName) {
        this.arrivals.set(portal.id, portal.to.arrival);
      }
    }
  }

  triggerAt(tileX: number, tileY: number): PortalDefinition | null {
    // The x range has to be checked before the multiply-add: an out-of-range tileX folds into
    // a neighbouring row and would report that row's trigger.
    if (tileX < 0 || tileX >= this.widthInTiles || tileY < 0) {
      return null;
    }
    return this.triggers.get(tileY * this.widthInTiles + tileX) ?? null;
  }

  arrivalFor(portalId: string): SpawnArea | null {
    return this.arrivals.get(portalId) ?? null;
  }
}

/** Boot-validation outcome. Every error refuses boot; warnings are authoring smells only. */
export interface PortalValidation {
  errors: readonly string[];
  warnings: readonly string[];
}

/**
 * Checks the portal table against the maps of the rooms it links, in the same spirit as the
 * spawn checks in `server.ts`: a dead portal (unwalkable trigger) or one that lands a client
 * inside a wall would otherwise stay invisible until someone walked into that door.
 *
 * `mapsByRoom` is keyed by matchmaking room name, so a room missing from it is an
 * unregistered room name — the check that `ROOM_DEFINITIONS` and this table agree.
 *
 * Every issue is collected rather than thrown at the first one: a boot failure that reveals
 * one typo per restart is a bad way to fix a table.
 */
export function validatePortalDefinitions(
  portals: readonly PortalDefinition[],
  mapsByRoom: ReadonlyMap<string, CollisionMap>,
): PortalValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  // String keys are fine here, unlike in the index above: this runs once, at boot.
  const triggerTilesByRoom = new Map<string, Set<string>>();

  for (const portal of portals) {
    let tiles = triggerTilesByRoom.get(portal.from.room);
    if (tiles === undefined) {
      tiles = new Set<string>();
      triggerTilesByRoom.set(portal.from.room, tiles);
    }
    for (const tile of portal.from.tiles) {
      tiles.add(tileKey(tile.tileX, tile.tileY));
    }
  }

  for (const [index, portal] of portals.entries()) {
    const label = portal.id.length === 0 ? `portal at row ${index}` : `portal "${portal.id}"`;
    if (portal.id.length === 0) {
      errors.push(`${label} has an empty id`);
    } else if (seenIds.has(portal.id)) {
      errors.push(`${label} is declared more than once`);
    } else {
      seenIds.add(portal.id);
    }

    const fromMap = mapsByRoom.get(portal.from.room);
    if (fromMap === undefined) {
      errors.push(`${label} leaves from "${portal.from.room}", which is not a registered room`);
    }
    if (portal.from.tiles.length === 0) {
      errors.push(`${label} has no trigger tiles`);
    } else if (fromMap !== undefined) {
      for (const tile of portal.from.tiles) {
        if (!fromMap.isWalkable(tile.tileX, tile.tileY)) {
          errors.push(
            `${label} triggers at (${tile.tileX},${tile.tileY}), which is not a walkable tile of room "${portal.from.room}"`,
          );
        }
      }
    }

    const { arrival } = portal.to;
    const toMap = mapsByRoom.get(portal.to.room);
    if (toMap === undefined) {
      errors.push(`${label} points at "${portal.to.room}", which is not a registered room`);
    }
    if (arrival.spreadRadiusInTiles < 0) {
      errors.push(
        `${label} has a negative arrival spreadRadiusInTiles (${arrival.spreadRadiusInTiles})`,
      );
    }
    if (toMap !== undefined && !toMap.isWalkable(arrival.tileX, arrival.tileY)) {
      errors.push(
        `${label} arrives at (${arrival.tileX},${arrival.tileY}), which is not a walkable tile of room "${portal.to.room}"`,
      );
    }
    // Not an error: a one-tile-wide passage has no free neighbour to land on, and landing on
    // the return door only feels sticky — it cannot loop, since arrival fires no trigger.
    if (triggerTilesByRoom.get(portal.to.room)?.has(tileKey(arrival.tileX, arrival.tileY))) {
      warnings.push(
        `${label} arrives at (${arrival.tileX},${arrival.tileY}), which is itself a portal trigger tile in room "${portal.to.room}"; prefer the tile beside the return door`,
      );
    }
  }

  return { errors, warnings };
}

function tileKey(tileX: number, tileY: number): string {
  return `${tileX},${tileY}`;
}
