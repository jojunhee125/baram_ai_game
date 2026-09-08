import type { LandmarkDescriptor } from "@zep-test/shared";
import type { CollisionMap, LandmarkArrival, LandmarkIndex, SpawnArea } from "../rooms/contracts";
import type { LandmarkDefinition } from "../rooms/landmarkDefinitions";

/**
 * {@link LandmarkIndex} over {@link LandmarkDefinition} rows, narrowed to one room at construction.
 * Takes `home` rather than a `CollisionMap`: unlike the portal/interactable indexes this needs no
 * spatial trigger lookup, only an id -> tile map, and a `tile: undefined` row resolves to the
 * room's own already-computed home instead of anything derived from the map.
 */
export class TableLandmarkIndex implements LandmarkIndex {
  private readonly byId = new Map<string, LandmarkArrival>();

  constructor(roomName: string | undefined, landmarks: readonly LandmarkDefinition[], home: SpawnArea) {
    if (roomName === undefined) {
      return;
    }
    for (const landmark of landmarks) {
      if (landmark.room !== roomName) {
        continue;
      }
      this.byId.set(landmark.id, {
        area: landmark.tile ?? home,
        requiresItemKey: landmark.requiresItemKey,
        deniedMessage: landmark.deniedMessage,
      });
    }
  }

  resolve(landmarkId: string): LandmarkArrival | null {
    return this.byId.get(landmarkId) ?? null;
  }
}

export interface LandmarkValidation {
  errors: readonly string[];
  warnings: readonly string[];
}

/**
 * Checks the server-side landmark table against the shared descriptor table (same id set, same
 * room per id — §1.2's compiler-less safety net) and against the maps it places tiles on, in the
 * same spirit as `validatePortalDefinitions`.
 */
export function validateLandmarkDefinitions(
  landmarks: readonly LandmarkDefinition[],
  descriptors: readonly LandmarkDescriptor[],
  mapsByRoom: ReadonlyMap<string, CollisionMap>,
  itemKeys: ReadonlySet<string>,
): LandmarkValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const descriptorById = new Map(descriptors.map((d) => [d.id, d]));
  const seenIds = new Set<string>();

  for (const [index, landmark] of landmarks.entries()) {
    const label = landmark.id.length === 0 ? `landmark at row ${index}` : `landmark "${landmark.id}"`;
    if (landmark.id.length === 0) {
      errors.push(`${label} has an empty id`);
    } else if (seenIds.has(landmark.id)) {
      errors.push(`${label} is declared more than once`);
    } else {
      seenIds.add(landmark.id);
    }

    const descriptor = descriptorById.get(landmark.id);
    if (descriptor === undefined) {
      errors.push(`${label} has no matching entry in the shared landmark descriptor table`);
    } else if (descriptor.room !== landmark.room) {
      errors.push(
        `${label} names room "${landmark.room}", which disagrees with the shared descriptor's "${descriptor.room}"`,
      );
    }

    const map = mapsByRoom.get(landmark.room);
    if (map === undefined) {
      errors.push(`${label} sits in "${landmark.room}", which is not a registered room`);
    }

    if (landmark.tile !== undefined) {
      if (landmark.tile.spreadRadiusInTiles < 0) {
        errors.push(`${label} has a negative spreadRadiusInTiles (${landmark.tile.spreadRadiusInTiles})`);
      }
      if (map !== undefined && !map.isWalkable(landmark.tile.tileX, landmark.tile.tileY)) {
        errors.push(
          `${label} sits at (${landmark.tile.tileX},${landmark.tile.tileY}), which is not a walkable tile of room "${landmark.room}"`,
        );
      }
    }

    if (landmark.requiresItemKey !== undefined || landmark.deniedMessage !== undefined) {
      if (landmark.requiresItemKey === undefined || landmark.deniedMessage === undefined) {
        errors.push(`${label} sets only one of requiresItemKey/deniedMessage; both or neither`);
      } else {
        if (!itemKeys.has(landmark.requiresItemKey)) {
          errors.push(`${label} requires item "${landmark.requiresItemKey}", which is not in the item catalogue`);
        }
        if (landmark.deniedMessage.length === 0) {
          errors.push(`${label} has an empty deniedMessage`);
        }
      }
    }
  }

  for (const descriptor of descriptors) {
    if (!seenIds.has(descriptor.id)) {
      errors.push(`shared landmark descriptor "${descriptor.id}" has no matching server-side row`);
    }
    if (descriptor.name.trim().length === 0) {
      warnings.push(`shared landmark descriptor "${descriptor.id}" has an empty name`);
    }
  }

  return { errors, warnings };
}
