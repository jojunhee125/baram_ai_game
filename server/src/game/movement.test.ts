import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Direction } from "@zep-test/shared";
import type { CollisionMap } from "../rooms/contracts";
import { isDirection, TileMovementResolver } from "./movement";

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

const resolver = new TileMovementResolver();

describe("TileMovementResolver.resolveStep", () => {
  const map = gridMap([
    "....",
    ".#..",
    "....",
  ]);

  it("steps one tile per direction, with Down increasing tileY", () => {
    assert.deepEqual(resolver.resolveStep({ tileX: 2, tileY: 1 }, Direction.Down, map), {
      tileX: 2,
      tileY: 2,
    });
    assert.deepEqual(resolver.resolveStep({ tileX: 2, tileY: 1 }, Direction.Up, map), {
      tileX: 2,
      tileY: 0,
    });
    assert.deepEqual(resolver.resolveStep({ tileX: 2, tileY: 0 }, Direction.Left, map), {
      tileX: 1,
      tileY: 0,
    });
    assert.deepEqual(resolver.resolveStep({ tileX: 2, tileY: 0 }, Direction.Right, map), {
      tileX: 3,
      tileY: 0,
    });
  });

  it("refuses a step past each map edge", () => {
    assert.equal(resolver.resolveStep({ tileX: 0, tileY: 0 }, Direction.Left, map), null);
    assert.equal(resolver.resolveStep({ tileX: 0, tileY: 0 }, Direction.Up, map), null);
    assert.equal(resolver.resolveStep({ tileX: 3, tileY: 2 }, Direction.Right, map), null);
    assert.equal(resolver.resolveStep({ tileX: 3, tileY: 2 }, Direction.Down, map), null);
  });

  it("allows a step onto the last in-bounds tile", () => {
    assert.deepEqual(resolver.resolveStep({ tileX: 2, tileY: 2 }, Direction.Right, map), {
      tileX: 3,
      tileY: 2,
    });
  });

  it("refuses a step onto a blocked tile from every side", () => {
    assert.equal(resolver.resolveStep({ tileX: 1, tileY: 0 }, Direction.Down, map), null);
    assert.equal(resolver.resolveStep({ tileX: 1, tileY: 2 }, Direction.Up, map), null);
    assert.equal(resolver.resolveStep({ tileX: 0, tileY: 1 }, Direction.Right, map), null);
    assert.equal(resolver.resolveStep({ tileX: 2, tileY: 1 }, Direction.Left, map), null);
  });

  it("refuses every direction on a single-tile map", () => {
    const tiny = gridMap(["."]);
    const from = { tileX: 0, tileY: 0 };
    for (const dir of [Direction.Down, Direction.Left, Direction.Right, Direction.Up]) {
      assert.equal(resolver.resolveStep(from, dir, tiny), null);
    }
  });

  it("does not mutate or alias the source position", () => {
    const from = { tileX: 1, tileY: 1 };
    const to = resolver.resolveStep(from, Direction.Right, map);
    assert.deepEqual(from, { tileX: 1, tileY: 1 });
    assert.notEqual(to, from);
  });

  it("checks bounds before walkability", () => {
    let queried = false;
    const outOfBoundsMap: CollisionMap = {
      widthInTiles: 2,
      heightInTiles: 2,
      isWalkable() {
        queried = true;
        return true;
      },
    };
    assert.equal(resolver.resolveStep({ tileX: 1, tileY: 1 }, Direction.Right, outOfBoundsMap), null);
    assert.equal(queried, false);
  });
});

describe("isDirection", () => {
  it("accepts every Direction value", () => {
    for (const dir of Object.values(Direction)) {
      assert.equal(isDirection(dir), true);
    }
  });

  it("rejects values a forged move message could carry", () => {
    for (const value of [-1, 4, 1.5, NaN, Infinity, "1", null, undefined, {}, []]) {
      assert.equal(isDirection(value), false, `expected ${String(value)} to be rejected`);
    }
  });
});
