import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LandmarkDescriptor } from "@zep-test/shared";
import type { CollisionMap } from "../rooms/contracts";
import type { LandmarkDefinition } from "../rooms/landmarkDefinitions";
import { validateLandmarkDefinitions } from "./landmarks";

/**
 * Pass T deep verification for Phase M, item 6: `validateLandmarkDefinitions` as a pure function,
 * mirroring `portals.test.ts`'s style for `validatePortalDefinitions`. Deliberately-broken tables
 * built here, never touching the real `server/src/rooms/landmarkDefinitions.ts`.
 */

/** '.' = walkable, '#' = blocked. Row index is tileY, column index is tileX. */
function gridMap(rows: string[]): CollisionMap {
  return {
    widthInTiles: rows[0]?.length ?? 0,
    heightInTiles: rows.length,
    isWalkable(tileX, tileY) {
      return rows[tileY]?.[tileX] === ".";
    },
  };
}

const MAP = gridMap(["......", "......", "......", "......"]);

function mapsFor(...rooms: string[]): ReadonlyMap<string, CollisionMap> {
  return new Map(rooms.map((room) => [room, MAP]));
}

const ITEM_KEYS = new Set(["entry-pass"]);

const VALID_DESCRIPTORS: readonly LandmarkDescriptor[] = [
  { id: "landmark-a", name: "A 광장", room: "a" },
  { id: "landmark-b", name: "B 입구", room: "b" },
];

const VALID_LANDMARKS: readonly LandmarkDefinition[] = [
  { id: "landmark-a", room: "a" },
  {
    id: "landmark-b",
    room: "b",
    tile: { tileX: 1, tileY: 1, spreadRadiusInTiles: 0 },
    requiresItemKey: "entry-pass",
    deniedMessage: "막혀 있습니다",
  },
];

describe("validateLandmarkDefinitions", () => {
  it("accepts a well-formed table with zero errors and zero warnings", () => {
    const result = validateLandmarkDefinitions(VALID_LANDMARKS, VALID_DESCRIPTORS, mapsFor("a", "b"), ITEM_KEYS);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it("rejects an empty landmark id", () => {
    const landmarks: readonly LandmarkDefinition[] = [{ id: "", room: "a" }];
    const descriptors: readonly LandmarkDescriptor[] = [{ id: "", name: "이름", room: "a" }];
    const result = validateLandmarkDefinitions(landmarks, descriptors, mapsFor("a"), ITEM_KEYS);
    assert.ok(result.errors.some((error) => /landmark at row 0 has an empty id/.test(error)));
  });

  it("rejects a duplicate landmark id", () => {
    const landmarks: readonly LandmarkDefinition[] = [
      { id: "landmark-a", room: "a" },
      { id: "landmark-a", room: "a" },
    ];
    const result = validateLandmarkDefinitions(landmarks, VALID_DESCRIPTORS, mapsFor("a"), ITEM_KEYS);
    assert.ok(result.errors.some((error) => /"landmark-a" is declared more than once/.test(error)));
  });

  it("rejects a server row with no matching shared descriptor", () => {
    const landmarks: readonly LandmarkDefinition[] = [{ id: "landmark-ghost", room: "a" }];
    const result = validateLandmarkDefinitions(landmarks, VALID_DESCRIPTORS, mapsFor("a"), ITEM_KEYS);
    assert.ok(
      result.errors.some((error) =>
        /"landmark-ghost" has no matching entry in the shared landmark descriptor table/.test(error),
      ),
    );
  });

  it("rejects a shared descriptor with no matching server-side row", () => {
    const descriptors: readonly LandmarkDescriptor[] = [
      ...VALID_DESCRIPTORS,
      { id: "landmark-c", name: "C", room: "c" },
    ];
    const result = validateLandmarkDefinitions(VALID_LANDMARKS, descriptors, mapsFor("a", "b", "c"), ITEM_KEYS);
    assert.ok(
      result.errors.some((error) =>
        /shared landmark descriptor "landmark-c" has no matching server-side row/.test(error),
      ),
    );
  });

  it("rejects a server/shared room mismatch for the same id", () => {
    const landmarks: readonly LandmarkDefinition[] = [{ id: "landmark-a", room: "wrong-room" }];
    const result = validateLandmarkDefinitions(landmarks, VALID_DESCRIPTORS, mapsFor("a", "wrong-room"), ITEM_KEYS);
    assert.ok(
      result.errors.some((error) =>
        /"landmark-a" names room "wrong-room", which disagrees with the shared descriptor's "a"/.test(error),
      ),
    );
  });

  it("rejects a landmark placed in an unregistered room", () => {
    const landmarks: readonly LandmarkDefinition[] = [{ id: "landmark-a", room: "nowhere" }];
    const descriptors: readonly LandmarkDescriptor[] = [{ id: "landmark-a", name: "A", room: "nowhere" }];
    const result = validateLandmarkDefinitions(landmarks, descriptors, mapsFor("a"), ITEM_KEYS);
    assert.ok(
      result.errors.some((error) => /"landmark-a" sits in "nowhere", which is not a registered room/.test(error)),
    );
  });

  it("rejects a landmark tile that is not walkable", () => {
    const landmarks: readonly LandmarkDefinition[] = [
      { id: "landmark-a", room: "a", tile: { tileX: 0, tileY: 0, spreadRadiusInTiles: 0 } },
    ];
    const blockedMap = gridMap(["#.....", "......"]);
    const result = validateLandmarkDefinitions(
      landmarks,
      VALID_DESCRIPTORS,
      new Map([["a", blockedMap], ["b", MAP]]),
      ITEM_KEYS,
    );
    assert.ok(
      result.errors.some((error) =>
        /"landmark-a" sits at \(0,0\), which is not a walkable tile of room "a"/.test(error),
      ),
    );
  });

  it("rejects a negative spreadRadiusInTiles on an authored tile", () => {
    const landmarks: readonly LandmarkDefinition[] = [
      { id: "landmark-a", room: "a", tile: { tileX: 1, tileY: 1, spreadRadiusInTiles: -1 } },
    ];
    const result = validateLandmarkDefinitions(landmarks, VALID_DESCRIPTORS, mapsFor("a", "b"), ITEM_KEYS);
    assert.ok(result.errors.some((error) => /"landmark-a" has a negative spreadRadiusInTiles \(-1\)/.test(error)));
  });

  it("rejects requiresItemKey set without deniedMessage", () => {
    const landmarks: readonly LandmarkDefinition[] = [
      { id: "landmark-a", room: "a", requiresItemKey: "entry-pass" },
    ];
    const result = validateLandmarkDefinitions(landmarks, VALID_DESCRIPTORS, mapsFor("a", "b"), ITEM_KEYS);
    assert.ok(
      result.errors.some((error) =>
        /"landmark-a" sets only one of requiresItemKey\/deniedMessage; both or neither/.test(error),
      ),
    );
  });

  it("rejects deniedMessage set without requiresItemKey", () => {
    const landmarks: readonly LandmarkDefinition[] = [
      { id: "landmark-a", room: "a", deniedMessage: "막혀 있습니다" },
    ];
    const result = validateLandmarkDefinitions(landmarks, VALID_DESCRIPTORS, mapsFor("a", "b"), ITEM_KEYS);
    assert.ok(
      result.errors.some((error) =>
        /"landmark-a" sets only one of requiresItemKey\/deniedMessage; both or neither/.test(error),
      ),
    );
  });

  it("rejects requiresItemKey referencing an item not in the catalogue", () => {
    const landmarks: readonly LandmarkDefinition[] = [
      { id: "landmark-a", room: "a", requiresItemKey: "no-such-item", deniedMessage: "막혀 있습니다" },
    ];
    const result = validateLandmarkDefinitions(landmarks, VALID_DESCRIPTORS, mapsFor("a", "b"), ITEM_KEYS);
    assert.ok(
      result.errors.some((error) =>
        /"landmark-a" requires item "no-such-item", which is not in the item catalogue/.test(error),
      ),
    );
  });

  it("rejects an empty deniedMessage even when requiresItemKey is valid", () => {
    const landmarks: readonly LandmarkDefinition[] = [
      { id: "landmark-a", room: "a", requiresItemKey: "entry-pass", deniedMessage: "" },
    ];
    const result = validateLandmarkDefinitions(landmarks, VALID_DESCRIPTORS, mapsFor("a", "b"), ITEM_KEYS);
    assert.ok(result.errors.some((error) => /"landmark-a" has an empty deniedMessage/.test(error)));
  });

  it("warns, but does not refuse, on a shared descriptor with a blank display name", () => {
    const descriptors: readonly LandmarkDescriptor[] = [
      { id: "landmark-a", name: "   ", room: "a" },
      { id: "landmark-b", name: "B 입구", room: "b" },
    ];
    const result = validateLandmarkDefinitions(VALID_LANDMARKS, descriptors, mapsFor("a", "b"), ITEM_KEYS);
    assert.deepEqual(result.errors, []);
    assert.ok(
      result.warnings.some((warning) => /shared landmark descriptor "landmark-a" has an empty name/.test(warning)),
    );
  });

  it("reports every offending row in one pass rather than stopping at the first", () => {
    const landmarks: readonly LandmarkDefinition[] = [
      { id: "", room: "a" },
      { id: "landmark-dup", room: "a" },
      { id: "landmark-dup", room: "a" },
      { id: "landmark-bad-room", room: "nowhere" },
      { id: "landmark-bad-item", room: "a", requiresItemKey: "no-such-item", deniedMessage: "x" },
    ];
    const descriptors: readonly LandmarkDescriptor[] = [
      { id: "", name: "", room: "a" },
      { id: "landmark-dup", name: "중복", room: "a" },
      { id: "landmark-bad-room", name: "잘못된 방", room: "nowhere" },
      { id: "landmark-bad-item", name: "잘못된 아이템", room: "a" },
    ];
    const result = validateLandmarkDefinitions(landmarks, descriptors, mapsFor("a"), ITEM_KEYS);
    assert.ok(result.errors.length >= 4, `expected at least 4 errors, got ${JSON.stringify(result.errors)}`);
  });
});
