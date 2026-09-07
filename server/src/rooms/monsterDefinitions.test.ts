import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollisionMap, InteractableDefinition, ItemDefinition, PortalDefinition } from "./contracts";
import {
  MONSTER_SPAWN_DEFINITIONS,
  MONSTER_TYPES,
  MonsterKind,
  validateMonsterSpawnDefinitions,
  type MonsterSpawnDefinition,
  type MonsterType,
} from "./monsterDefinitions";

/**
 * `validateMonsterSpawnDefinitions` is wired into `server.ts`'s boot sequence (the same way
 * `validatePortalDefinitions` is, which `game/portals.test.ts` covers directly) but had no unit
 * test anywhere in the suite before this file — the possession-quantity check Phase G added to it
 * was asserted only by a comment, never exercised.
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

const ITEMS: readonly ItemDefinition[] = [
  { key: "acorn", name: "도토리", icon: "acorn" },
  { key: "entry-pass", name: "입장권", icon: "entry-pass", possession: true },
];

const NO_PORTALS: readonly PortalDefinition[] = [];
const NO_OBJECTS: readonly InteractableDefinition[] = [];

function mapsFor(...rooms: string[]): ReadonlyMap<string, CollisionMap> {
  return new Map(rooms.map((room) => [room, MAP]));
}

const ONE_TYPE = (loot: MonsterType["loot"]): ReadonlyMap<MonsterKind, MonsterType> =>
  new Map([
    [
      MonsterKind.Squirrel,
      {
        kind: MonsterKind.Squirrel,
        maxHp: 12,
        damage: 5,
        attackCooldownMs: 1200,
        wanderStepIntervalMs: 1600,
        chaseStepIntervalMs: 600,
        aggroRadiusTiles: 2,
        leashRadiusTiles: 8,
        respawnDelayMs: 8000,
        loot,
      },
    ],
  ]);

function oneSpawn(overrides: Partial<MonsterSpawnDefinition> = {}): MonsterSpawnDefinition {
  return {
    id: "s1",
    room: "a",
    kind: MonsterKind.Squirrel,
    at: { tileX: 1, tileY: 1 },
    wanderRadiusTiles: 0,
    ...overrides,
  };
}

describe("validateMonsterSpawnDefinitions", () => {
  it("accepts a well-formed table", () => {
    const { errors, warnings } = validateMonsterSpawnDefinitions(
      [oneSpawn()],
      ONE_TYPE([{ itemKey: "acorn", chance: 0.5, quantity: 1 }]),
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    assert.deepEqual({ errors, warnings }, { errors: [], warnings: [] });
  });

  it("rejects a possession item drop with quantity other than 1", () => {
    const { errors } = validateMonsterSpawnDefinitions(
      [oneSpawn()],
      ONE_TYPE([{ itemKey: "entry-pass", chance: 0.15, quantity: 2 }]),
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    assert.deepEqual(errors, [
      'monster type "squirrel" loot row 0 drops possession item "entry-pass" with quantity 2, which must be 1',
    ]);
  });

  it("accepts a possession item drop with quantity exactly 1", () => {
    const { errors } = validateMonsterSpawnDefinitions(
      [oneSpawn()],
      ONE_TYPE([{ itemKey: "entry-pass", chance: 0.15, quantity: 1 }]),
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    assert.deepEqual(errors, []);
  });

  it("rejects a loot row naming an item outside the catalogue", () => {
    const { errors } = validateMonsterSpawnDefinitions(
      [oneSpawn()],
      ONE_TYPE([{ itemKey: "no-such-item", chance: 0.5, quantity: 1 }]),
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    assert.deepEqual(errors, [
      'monster type "squirrel" loot row 0 drops "no-such-item", which is not in the item catalogue',
    ]);
  });

  it("rejects a loot chance outside (0, 1]", () => {
    for (const chance of [0, -0.1, 1.01]) {
      const { errors } = validateMonsterSpawnDefinitions(
        [oneSpawn()],
        ONE_TYPE([{ itemKey: "acorn", chance, quantity: 1 }]),
        ITEMS,
        mapsFor("a"),
        NO_PORTALS,
        NO_OBJECTS,
      );
      assert.equal(errors.length, 1, `chance ${chance}`);
      assert.match(errors[0] ?? "", /outside \(0, 1\]/);
    }
  });

  it("rejects a non-positive-integer loot quantity", () => {
    for (const quantity of [0, -1, 1.5]) {
      const { errors } = validateMonsterSpawnDefinitions(
        [oneSpawn()],
        ONE_TYPE([{ itemKey: "acorn", chance: 0.5, quantity }]),
        ITEMS,
        mapsFor("a"),
        NO_PORTALS,
        NO_OBJECTS,
      );
      assert.equal(errors.length, 1, `quantity ${quantity}`);
      assert.match(errors[0] ?? "", /not a positive integer/);
    }
  });

  it("rejects a monster type filed under a key that does not match its own kind", () => {
    const mismatched = new Map(ONE_TYPE([]));
    mismatched.set(MonsterKind.Squirrel, { ...mismatched.get(MonsterKind.Squirrel)!, kind: MonsterKind.Rabbit });
    const { errors } = validateMonsterSpawnDefinitions(
      [oneSpawn()],
      mismatched,
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    assert.deepEqual(errors, [
      'monster type "squirrel" is filed under a key that does not match its own kind "rabbit"',
    ]);
  });

  it("rejects an empty id, a duplicate id, and an id with leading/trailing whitespace", () => {
    const { errors } = validateMonsterSpawnDefinitions(
      [
        oneSpawn({ id: "" }),
        oneSpawn({ id: "dup" }),
        oneSpawn({ id: "dup" }),
        oneSpawn({ id: " padded" }),
      ],
      ONE_TYPE([]),
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    // Only the *second* "dup" errors (the first is recorded and passes); 3 rows, 3 issues.
    assert.equal(errors.length, 3, JSON.stringify(errors));
    assert.match(errors[0] ?? "", /row 0 has an empty id/);
    assert.match(errors[1] ?? "", /"dup" is declared more than once/);
    assert.match(errors[2] ?? "", /" padded" has leading or trailing whitespace/);
  });

  it("rejects an unknown monster kind and a spawn in an unregistered room", () => {
    const { errors } = validateMonsterSpawnDefinitions(
      [oneSpawn({ kind: MonsterKind.Deer, room: "nowhere" })],
      ONE_TYPE([]),
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? "", /has no entry in MONSTER_TYPES/);
    assert.match(errors[1] ?? "", /sits in "nowhere", which is not a registered room/);
  });

  it("rejects a spawn tile that is not walkable", () => {
    const walled = new Map<string, CollisionMap>([["a", gridMap(["#....."])]]);
    const { errors } = validateMonsterSpawnDefinitions(
      [oneSpawn({ at: { tileX: 0, tileY: 0 } })],
      ONE_TYPE([]),
      ITEMS,
      walled,
      NO_PORTALS,
      NO_OBJECTS,
    );
    assert.deepEqual(errors, ['monster spawn "s1" spawns at (0,0), which is not a walkable tile of room "a"']);
  });

  it("rejects a negative wanderRadiusTiles", () => {
    const { errors } = validateMonsterSpawnDefinitions(
      [oneSpawn({ wanderRadiusTiles: -1 })],
      ONE_TYPE([]),
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    assert.deepEqual(errors, ['monster spawn "s1" has a wanderRadiusTiles of -1, which is not a non-negative integer']);
  });

  it("warns, without refusing, when a spawn sits on a portal trigger or an object tile", () => {
    const onPortal: readonly PortalDefinition[] = [
      {
        id: "p",
        from: { room: "a", tiles: [{ tileX: 1, tileY: 1 }] },
        to: { room: "a", arrival: { tileX: 2, tileY: 2, spreadRadiusInTiles: 0 } },
      },
    ];
    const { errors, warnings } = validateMonsterSpawnDefinitions(
      [oneSpawn({ at: { tileX: 1, tileY: 1 } })],
      ONE_TYPE([]),
      ITEMS,
      mapsFor("a"),
      onPortal,
      NO_OBJECTS,
    );
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /portal trigger or arrival tile/);
  });

  it("collects every issue instead of stopping at the first", () => {
    const { errors } = validateMonsterSpawnDefinitions(
      [oneSpawn({ id: "", kind: MonsterKind.Deer, wanderRadiusTiles: -1, at: { tileX: 9, tileY: 9 } })],
      ONE_TYPE([{ itemKey: "no-such-item", chance: 2, quantity: 0 }]),
      ITEMS,
      mapsFor("a"),
      NO_PORTALS,
      NO_OBJECTS,
    );
    // 3 loot-row issues (unknown item, chance out of range, bad quantity) + empty id + unknown
    // kind + bad wanderRadiusTiles + unwalkable tile = 7.
    assert.equal(errors.length, 7, JSON.stringify(errors));
  });
});

describe("MONSTER_SPAWN_DEFINITIONS / MONSTER_TYPES against the real room maps", () => {
  it("passes its own boot validation", async () => {
    const { TiledMapLoader } = await import("../game/tiledMap");
    const { ROOM_DEFINITIONS } = await import("./definitions");
    const { PORTAL_DEFINITIONS } = await import("./portalDefinitions");
    const { INTERACTABLE_DEFINITIONS } = await import("./interactableDefinitions");
    const { ITEM_DEFINITIONS } = await import("./itemDefinitions");

    const loader = new TiledMapLoader();
    const mapsByRoom = new Map<string, CollisionMap>();
    for (const definition of ROOM_DEFINITIONS) {
      mapsByRoom.set(definition.name, await loader.load(definition.mapKey));
    }

    const { errors } = validateMonsterSpawnDefinitions(
      MONSTER_SPAWN_DEFINITIONS,
      MONSTER_TYPES,
      ITEM_DEFINITIONS,
      mapsByRoom,
      PORTAL_DEFINITIONS,
      INTERACTABLE_DEFINITIONS,
    );
    assert.deepEqual(errors, []);
  });
});
