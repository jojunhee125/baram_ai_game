import { InteractableKind } from "@zep-test/shared";
import type {
  CollisionMap,
  InteractableDefinition,
  InteractableIndex,
  InteractableMarkerTile,
  PortalDefinition,
  RoomDefinition,
} from "../rooms/contracts";

/**
 * {@link InteractableIndex} over {@link InteractableDefinition} rows, narrowed to one room at
 * construction.
 *
 * Tile lookup keys on the same linear index the collision grid uses
 * (`tileY * widthInTiles + tileX`) rather than on a `"x,y"` string, for the reason
 * {@link import("./portals").TablePortalIndex} gives: `at` runs on every accepted move, right
 * behind the portal lookup, and a key built per move is per-move garbage on the room's hottest
 * path. `byId` may key on a string — it runs once per answered quiz.
 */
export class TableInteractableIndex implements InteractableIndex {
  private readonly byTile = new Map<number, InteractableDefinition>();
  private readonly byObjectId = new Map<string, InteractableDefinition>();
  private readonly markers: InteractableMarkerTile[] = [];
  private readonly widthInTiles: number;

  /**
   * `roomName` is `string | undefined` for the same reason as in `TablePortalIndex`: a room built
   * without the matchmaker has no `roomName` at runtime even though Colyseus types it as `string`.
   * Undefined matches no row, leaving an index that answers null.
   */
  constructor(
    roomName: string | undefined,
    interactables: readonly InteractableDefinition[],
    map: CollisionMap,
  ) {
    this.widthInTiles = map.widthInTiles;
    if (roomName === undefined) {
      return;
    }
    for (const object of interactables) {
      if (object.at.room !== roomName) {
        continue;
      }
      this.byObjectId.set(object.id, object);
      for (const tile of object.at.tiles) {
        this.byTile.set(tile.tileY * this.widthInTiles + tile.tileX, object);
        this.markers.push({ tileX: tile.tileX, tileY: tile.tileY, kind: object.kind });
      }
    }
  }

  at(tileX: number, tileY: number): InteractableDefinition | null {
    // The x range has to be checked before the multiply-add: an out-of-range tileX folds into
    // a neighbouring row and would report that row's object.
    if (tileX < 0 || tileX >= this.widthInTiles || tileY < 0) {
      return null;
    }
    return this.byTile.get(tileY * this.widthInTiles + tileX) ?? null;
  }

  byId(objectId: string): InteractableDefinition | null {
    return this.byObjectId.get(objectId) ?? null;
  }

  markerTiles(): readonly InteractableMarkerTile[] {
    return this.markers;
  }
}

/** Boot-validation outcome. Every error refuses boot; warnings are authoring smells only. */
export interface InteractableValidation {
  errors: readonly string[];
  warnings: readonly string[];
}

/**
 * Checks the object table against the maps it is placed on and against the portal table, in the
 * same spirit as `validatePortalDefinitions`: every one of these faults produces an object that
 * looks authored but cannot work, and none of them would surface until somebody walked onto that
 * one tile.
 *
 * `portals` is a parameter because two of the checks are about the two tables together — a tile
 * that fires both a portal and an object opens a panel into a room that is already leaving.
 *
 * Every issue is collected rather than thrown at the first one: a boot failure that reveals one
 * typo per restart is a bad way to fix a table.
 *
 * `rooms` is only for the spawn/interactable/portal-trigger overlap check below (Info-level): a
 * room whose spawn square reaches one of those tiles still boots fine, it just opens a panel or
 * fires a door the moment someone joins there.
 */
export function validateInteractableDefinitions(
  interactables: readonly InteractableDefinition[],
  portals: readonly PortalDefinition[],
  mapsByRoom: ReadonlyMap<string, CollisionMap>,
  rooms: readonly RoomDefinition[],
): InteractableValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  // Composite string keys, unlike the index above: this runs once, at boot.
  const portalTriggers = new Set<string>();
  const portalArrivals = new Set<string>();
  /** Room+tile -> the label of the object row that claimed it first. */
  const claimedBy = new Map<string, string>();

  for (const portal of portals) {
    for (const tile of portal.from.tiles) {
      portalTriggers.add(roomTileKey(portal.from.room, tile.tileX, tile.tileY));
    }
    const { arrival } = portal.to;
    portalArrivals.add(roomTileKey(portal.to.room, arrival.tileX, arrival.tileY));
  }

  for (const [index, object] of interactables.entries()) {
    const label = object.id.length === 0 ? `object at row ${index}` : `object "${object.id}"`;
    if (object.id.length === 0) {
      errors.push(`${label} has an empty id`);
    } else if (seenIds.has(object.id)) {
      errors.push(`${label} is declared more than once`);
    } else {
      seenIds.add(object.id);
    }

    const { room } = object.at;
    const map = mapsByRoom.get(room);
    if (map === undefined) {
      errors.push(`${label} sits in "${room}", which is not a registered room`);
    }
    if (object.at.tiles.length === 0) {
      errors.push(`${label} has no tiles`);
    }

    for (const tile of object.at.tiles) {
      const key = roomTileKey(room, tile.tileX, tile.tileY);
      const at = `(${tile.tileX},${tile.tileY})`;
      if (map !== undefined && !map.isWalkable(tile.tileX, tile.tileY)) {
        errors.push(`${label} occupies ${at}, which is not a walkable tile of room "${room}"`);
      }
      const owner = claimedBy.get(key);
      if (owner === undefined) {
        claimedBy.set(key, label);
      } else {
        errors.push(
          `${label} occupies ${at} of room "${room}", which is already occupied by ${owner}; the tile index would keep only one of them`,
        );
      }
      if (portalTriggers.has(key)) {
        errors.push(
          `${label} occupies ${at}, which is a portal trigger tile in room "${room}"; the panel would open into a room that is already leaving`,
        );
      }
      // Not an error: a narrow passage may genuinely have nowhere else to put the object. But an
      // arrival is not a step, so the object stays shut for anyone who comes in through that door.
      if (portalArrivals.has(key)) {
        warnings.push(
          `${label} occupies ${at}, which is a portal arrival tile in room "${room}"; arriving there opens nothing until the player steps off and back on`,
        );
      }
    }

    if (object.title.trim().length === 0) {
      errors.push(`${label} has an empty title`);
    }

    switch (object.kind) {
      case InteractableKind.Link: {
        let url: URL | null = null;
        try {
          url = new URL(object.url);
        } catch {
          errors.push(`${label} has a url that is not absolute: ${JSON.stringify(object.url)}`);
        }
        if (url !== null && url.protocol !== "http:" && url.protocol !== "https:") {
          errors.push(`${label} has a "${url.protocol}" url; only http and https are opened`);
        }
        break;
      }
      case InteractableKind.Notice:
        if (object.body.trim().length === 0) {
          errors.push(`${label} has an empty body`);
        }
        break;
      case InteractableKind.Quiz: {
        if (object.question.trim().length === 0) {
          errors.push(`${label} has an empty question`);
        }
        if (object.choices.length < 2) {
          errors.push(`${label} offers ${object.choices.length} choice(s); a quiz needs two or more`);
        }
        const { answerIndex } = object;
        if (
          !Number.isInteger(answerIndex) ||
          answerIndex < 0 ||
          answerIndex >= object.choices.length
        ) {
          errors.push(
            `${label} has answerIndex ${answerIndex}, which is outside its ${object.choices.length} choices`,
          );
        }
        break;
      }
    }
  }

  // Info-level only: a spawn square is a Chebyshev square of half-extent spreadRadiusInTiles
  // around `spawn` (the same shape `MetaverseRoom.pickSpawnTile` samples from), so a wide-spread
  // room like grand-plaza can reach a tile far from its centre. Nothing here refuses boot — the
  // worst case is a panel opening, or a door firing, the moment a joining player lands on it.
  for (const room of rooms) {
    const { spawn } = room;
    for (let tileX = spawn.tileX - spawn.spreadRadiusInTiles; tileX <= spawn.tileX + spawn.spreadRadiusInTiles; tileX++) {
      for (let tileY = spawn.tileY - spawn.spreadRadiusInTiles; tileY <= spawn.tileY + spawn.spreadRadiusInTiles; tileY++) {
        const key = roomTileKey(room.name, tileX, tileY);
        const at = `(${tileX},${tileY})`;
        const owner = claimedBy.get(key);
        if (owner !== undefined) {
          warnings.push(
            `room "${room.name}" spawn square reaches ${at}, occupied by ${owner}; a joining player may open its panel immediately`,
          );
        }
        if (portalTriggers.has(key)) {
          warnings.push(
            `room "${room.name}" spawn square reaches ${at}, a portal trigger tile; a joining player may fire it immediately`,
          );
        }
      }
    }
  }

  return { errors, warnings };
}

function roomTileKey(room: string, tileX: number, tileY: number): string {
  return `${room}|${tileX},${tileY}`;
}
