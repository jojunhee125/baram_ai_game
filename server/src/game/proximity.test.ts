import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_RADIUS_TILES, VIEW_RADIUS_TILES, type TilePosition } from "@zep-test/shared";
import type { ProximityIndex } from "../rooms/contracts";
import { chebyshevDistance, NaiveProximityIndex, UniformGridProximityIndex } from "./proximity";

/** grand-plaza's dimensions and the cell size the room actually uses, so the tests exercise the real geometry. */
const MAP_WIDTH_TILES = 160;
const MAP_HEIGHT_TILES = 145;
const CELL_SIZE_TILES = VIEW_RADIUS_TILES + 1;

const IMPLEMENTATIONS: ReadonlyArray<readonly [string, () => ProximityIndex]> = [
  ["NaiveProximityIndex", () => new NaiveProximityIndex()],
  [
    "UniformGridProximityIndex",
    () => new UniformGridProximityIndex(MAP_WIDTH_TILES, MAP_HEIGHT_TILES, CELL_SIZE_TILES),
  ],
];

function query(index: ProximityIndex, origin: TilePosition, radiusInTiles: number): string[] {
  return [...index.within(origin, radiusInTiles, [])].sort();
}

function populate(index: ProximityIndex, players: Record<string, TilePosition>): ProximityIndex {
  for (const [sessionId, position] of Object.entries(players)) {
    index.insert(sessionId, position);
  }
  return index;
}

/**
 * mulberry32. A fixed seed keeps a differential failure reproducible — the whole point of the
 * oracle is being able to re-run the exact sequence that disagreed.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const [name, create] of IMPLEMENTATIONS) {
  describe(`${name}.within`, () => {
    it("returns nothing when the room is empty", () => {
      const index = create();
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, CHAT_RADIUS_TILES), []);
    });

    it("includes the origin's own session", () => {
      const index = populate(create(), { self: { tileX: 5, tileY: 5 } });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), ["self"]);
    });

    it("includes a player at exactly the radius and excludes the next tile out", () => {
      const index = populate(create(), {
        onEdge: { tileX: 8, tileY: 5 },
        justOutside: { tileX: 9, tileY: 5 },
      });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), ["onEdge"]);
    });

    it("measures Chebyshev distance, so a full diagonal is still in range", () => {
      const index = populate(create(), {
        corner: { tileX: 8, tileY: 8 },
        beyondCorner: { tileX: 9, tileY: 8 },
      });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), ["corner"]);
    });

    it("matches only the exact tile at radius 0", () => {
      const index = populate(create(), {
        same: { tileX: 5, tileY: 5 },
        adjacent: { tileX: 5, tileY: 6 },
      });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 0), ["same"]);
    });

    it("returns nothing for a negative radius", () => {
      const index = populate(create(), { same: { tileX: 5, tileY: 5 } });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, -1), []);
    });

    it("is symmetric across all four quadrants", () => {
      const index = populate(create(), {
        upLeft: { tileX: 2, tileY: 2 },
        upRight: { tileX: 8, tileY: 2 },
        downLeft: { tileX: 2, tileY: 8 },
        downRight: { tileX: 8, tileY: 8 },
        farAway: { tileX: 40, tileY: 40 },
      });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), [
        "downLeft",
        "downRight",
        "upLeft",
        "upRight",
      ]);
    });

    it("finds a player standing in the far corner of the map", () => {
      const index = populate(create(), {
        corner: { tileX: MAP_WIDTH_TILES - 1, tileY: MAP_HEIGHT_TILES - 1 },
      });
      assert.deepEqual(
        query(index, { tileX: MAP_WIDTH_TILES - 1, tileY: MAP_HEIGHT_TILES - 1 }, VIEW_RADIUS_TILES),
        ["corner"],
      );
    });

    it("does not fold tiles left of the origin into the query when the radius runs off the map", () => {
      const index = populate(create(), {
        nearOrigin: { tileX: 0, tileY: 0 },
        farRight: { tileX: VIEW_RADIUS_TILES + 1, tileY: 0 },
      });
      assert.deepEqual(query(index, { tileX: 0, tileY: 0 }, VIEW_RADIUS_TILES), ["nearOrigin"]);
    });

    it("tracks a player through move() and drops it on remove()", () => {
      const index = populate(create(), { walker: { tileX: 40, tileY: 40 } });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), []);

      index.move("walker", { tileX: 6, tileY: 5 });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), ["walker"]);

      // Back out across a cell boundary, then in again: the cell bookkeeping has to survive both.
      index.move("walker", { tileX: 40, tileY: 40 });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), []);
      index.move("walker", { tileX: 4, tileY: 4 });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), ["walker"]);

      index.remove("walker");
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), []);
    });

    it("ignores move() for an unknown session and remove() is idempotent", () => {
      const index = populate(create(), { known: { tileX: 5, tileY: 5 } });
      index.move("ghost", { tileX: 5, tileY: 5 });
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), ["known"]);

      index.remove("ghost");
      index.remove("known");
      index.remove("known");
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 3), []);
    });

    it("does not read the caller's position object after the call", () => {
      const index = create();
      const spawn = { tileX: 5, tileY: 5 };
      index.insert("copied", spawn);
      spawn.tileX = 100;
      assert.deepEqual(query(index, { tileX: 5, tileY: 5 }, 0), ["copied"]);
    });

    it("clears the caller's buffer and returns that same array", () => {
      const index = populate(create(), { only: { tileX: 5, tileY: 5 } });
      const buffer = ["stale", "entries"];
      const result = index.within({ tileX: 5, tileY: 5 }, 3, buffer);
      assert.equal(result, buffer, "the caller's buffer is returned, not a copy");
      assert.deepEqual(result, ["only"]);

      index.within({ tileX: 500, tileY: 500 }, 3, buffer);
      assert.deepEqual(buffer, [], "an empty result empties the buffer");
    });
  });
}

/**
 * Replays random churn against both implementations and asserts they never disagree.
 *
 * `positionOverhang` is how far outside the map a player may be indexed. 0 is the only state the
 * room can reach (spawn and every step are validated walkable), and it is also the reason the
 * grid's cell clamp is invisible there: an out-of-range cell index reads as `undefined` and gets
 * skipped, which is indistinguishable from clamping while every player is on the map. A positive
 * overhang is what makes the clamp observable, so it pins the index's own contract rather than
 * the caller's invariant.
 */
function assertGridMatchesOracle(seed: number, positionOverhang: number): void {
  const random = seededRandom(seed);
  const grid = new UniformGridProximityIndex(MAP_WIDTH_TILES, MAP_HEIGHT_TILES, CELL_SIZE_TILES);
  const oracle = new NaiveProximityIndex();
  const gridBuffer: string[] = [];
  const oracleBuffer: string[] = [];

  const randomTile = (): TilePosition => ({
    tileX: Math.floor(random() * (MAP_WIDTH_TILES + 2 * positionOverhang)) - positionOverhang,
    tileY: Math.floor(random() * (MAP_HEIGHT_TILES + 2 * positionOverhang)) - positionOverhang,
  });

  const live: string[] = [];
  for (let i = 0; i < 500; i++) {
    const sessionId = `p${i}`;
    const position = randomTile();
    grid.insert(sessionId, position);
    oracle.insert(sessionId, position);
    live.push(sessionId);
  }

  for (let round = 0; round < 4000; round++) {
    // Churn alongside the queries: a stale cell entry only shows up after a move or a remove.
    const subject = live[Math.floor(random() * live.length)];
    if (subject !== undefined) {
      if (random() < 0.05) {
        grid.remove(subject);
        oracle.remove(subject);
      } else {
        const destination = randomTile();
        grid.move(subject, destination);
        oracle.move(subject, destination);
      }
    }

    // Origins deliberately reach outside the map on both axes: that is where a cell range
    // that clamps or floors incorrectly stops agreeing with a plain distance scan.
    const origin: TilePosition = {
      tileX: Math.floor(random() * (MAP_WIDTH_TILES + 60)) - 30,
      tileY: Math.floor(random() * (MAP_HEIGHT_TILES + 60)) - 30,
    };
    const radius = Math.floor(random() * (VIEW_RADIUS_TILES + 3));

    const fromGrid = [...grid.within(origin, radius, gridBuffer)].sort();
    const fromOracle = [...oracle.within(origin, radius, oracleBuffer)].sort();
    assert.deepEqual(
      fromGrid,
      fromOracle,
      `round ${round}: disagreement at origin (${origin.tileX},${origin.tileY}) radius ${radius}`,
    );
  }
}

/**
 * The grid's clamping and cell-range arithmetic are exactly the kind of thing that stays
 * silently wrong under hand-written cases, so it is checked against the naive scan instead.
 */
describe("UniformGridProximityIndex vs NaiveProximityIndex", () => {
  it("answers thousands of random queries identically to the oracle", () => {
    assertGridMatchesOracle(0x5eed_1234, 0);
  });

  it("still agrees when the players themselves sit outside the map", () => {
    assertGridMatchesOracle(0x5eed_1234, 20);
  });
});

describe("chebyshevDistance", () => {
  it("is the larger of the two axis distances, regardless of sign", () => {
    assert.equal(chebyshevDistance({ tileX: 0, tileY: 0 }, { tileX: 0, tileY: 0 }), 0);
    assert.equal(chebyshevDistance({ tileX: 0, tileY: 0 }, { tileX: 3, tileY: 5 }), 5);
    assert.equal(chebyshevDistance({ tileX: 3, tileY: 5 }, { tileX: 0, tileY: 0 }), 5);
    assert.equal(chebyshevDistance({ tileX: -4, tileY: 2 }, { tileX: 1, tileY: 4 }), 5);
  });
});
