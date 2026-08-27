import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  CHAT_RADIUS_TILES,
  VIEWPORT_HEIGHT_TILES,
  VIEWPORT_WIDTH_TILES,
  VIEW_RADIUS_MARGIN_TILES,
  VIEW_RADIUS_TILES,
  cameraBorderTiles,
  maxVisibleTileDistance,
} from "@zep-test/shared";
import { TiledMapLoader } from "../game/tiledMap";
import type { CollisionMap } from "./contracts";
import { ROOM_DEFINITIONS } from "./definitions";

/**
 * The camera geometry in `shared/src/camera.ts` is a contract with three parties that cannot
 * see each other: the map generators bake a non-walkable border band, the client sizes its
 * canvas, and the server derives its sync radius. Nothing at runtime notices when one of them
 * drifts — a too-thin band just makes the camera clamp and quietly breaks the "the local
 * player is always screen-centred" premise that VIEW_RADIUS_TILES is an upper bound under.
 *
 * These tests re-derive every number from `cameraBorderTiles` / `maxVisibleTileDistance` and
 * read the real map files through `TiledMapLoader`, so a viewport change fails here rather
 * than shipping. No coordinate below is hardcoded on purpose.
 */

const BORDER = cameraBorderTiles(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES);

/** Every map a client can actually be in, taken from the registration table, not a literal. */
const MAP_KEYS = [...new Set(ROOM_DEFINITIONS.map((definition) => definition.mapKey))];

interface BandViolation {
  tileX: number;
  tileY: number;
  side: string;
}

/** Which border band, if any, a tile falls in. */
function bandSideOf(map: CollisionMap, tileX: number, tileY: number): string | null {
  if (tileX < BORDER.left) return "left";
  if (tileX >= map.widthInTiles - BORDER.right) return "right";
  if (tileY < BORDER.top) return "top";
  if (tileY >= map.heightInTiles - BORDER.bottom) return "bottom";
  return null;
}

function walkableTilesInBorderBand(map: CollisionMap): BandViolation[] {
  const violations: BandViolation[] = [];
  for (let tileY = 0; tileY < map.heightInTiles; tileY++) {
    for (let tileX = 0; tileX < map.widthInTiles; tileX++) {
      const side = bandSideOf(map, tileX, tileY);
      if (side !== null && map.isWalkable(tileX, tileY)) {
        violations.push({ tileX, tileY, side });
      }
    }
  }
  return violations;
}

/** Longest run of consecutive walkable tiles on any single row, and which row it was on. */
function longestWalkableRun(map: CollisionMap): { length: number; tileY: number; startX: number } {
  let best = { length: 0, tileY: -1, startX: -1 };
  for (let tileY = 0; tileY < map.heightInTiles; tileY++) {
    let run = 0;
    for (let tileX = 0; tileX < map.widthInTiles; tileX++) {
      run = map.isWalkable(tileX, tileY) ? run + 1 : 0;
      if (run > best.length) {
        best = { length: run, tileY, startX: tileX - run + 1 };
      }
    }
  }
  return best;
}

describe("map ↔ camera invariants", () => {
  const maps = new Map<string, CollisionMap>();

  before(async () => {
    const loader = new TiledMapLoader();
    for (const mapKey of MAP_KEYS) {
      maps.set(mapKey, await loader.load(mapKey));
    }
  });

  it("loads every map named by ROOM_DEFINITIONS", () => {
    assert.ok(MAP_KEYS.length >= 2, `expected at least 2 room maps, got ${MAP_KEYS.length}`);
    for (const mapKey of MAP_KEYS) {
      assert.ok(maps.has(mapKey), `map "${mapKey}" was not loaded`);
    }
  });

  // (1) The band the camera needs must hold no walkable tile, in every map, on all four sides.
  for (const mapKey of MAP_KEYS) {
    it(`"${mapKey}" has no walkable tile inside the camera border band`, () => {
      const map = maps.get(mapKey);
      assert.ok(map, `map "${mapKey}" not loaded`);

      // Guard the guard: a map smaller than the band would make the check vacuous.
      assert.ok(
        map.widthInTiles > BORDER.left + BORDER.right,
        `"${mapKey}" is ${map.widthInTiles} tiles wide, not wider than the ${BORDER.left}+${BORDER.right} horizontal band`,
      );
      assert.ok(
        map.heightInTiles > BORDER.top + BORDER.bottom,
        `"${mapKey}" is ${map.heightInTiles} tiles tall, not taller than the ${BORDER.top}+${BORDER.bottom} vertical band`,
      );

      const violations = walkableTilesInBorderBand(map);
      const sample = violations
        .slice(0, 8)
        .map((v) => `(${v.tileX},${v.tileY}) ${v.side}`)
        .join(", ");
      assert.equal(
        violations.length,
        0,
        `"${mapKey}" (${map.widthInTiles}x${map.heightInTiles}) has ${violations.length} walkable tile(s) inside the camera band ` +
          `{left:${BORDER.left},right:${BORDER.right},top:${BORDER.top},bottom:${BORDER.bottom}}; ` +
          `first: ${sample}`,
      );
    });
  }

  // (2) The sync radius is the camera's furthest visible tile plus the approach margin.
  it("VIEW_RADIUS_TILES equals maxVisibleTileDistance + VIEW_RADIUS_MARGIN_TILES", () => {
    const furthestVisible = maxVisibleTileDistance(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES);
    assert.equal(
      VIEW_RADIUS_TILES,
      furthestVisible + VIEW_RADIUS_MARGIN_TILES,
      `VIEW_RADIUS_TILES is ${VIEW_RADIUS_TILES} but the ${VIEWPORT_WIDTH_TILES}x${VIEWPORT_HEIGHT_TILES} viewport sees ${furthestVisible} tiles + ${VIEW_RADIUS_MARGIN_TILES} margin = ${furthestVisible + VIEW_RADIUS_MARGIN_TILES}`,
    );
  });

  // (3) Chat reaches exactly as far as the smallest on-screen direction, and never further
  //     than the sync radius (or a client renders a bubble over a player it does not have).
  it("CHAT_RADIUS_TILES equals the viewport's upward extent and stays within VIEW_RADIUS_TILES", () => {
    assert.equal(
      CHAT_RADIUS_TILES,
      BORDER.top,
      `CHAT_RADIUS_TILES is ${CHAT_RADIUS_TILES} but the ${VIEWPORT_WIDTH_TILES}x${VIEWPORT_HEIGHT_TILES} viewport's upward extent is ${BORDER.top}`,
    );
    assert.ok(
      CHAT_RADIUS_TILES <= VIEW_RADIUS_TILES,
      `CHAT_RADIUS_TILES (${CHAT_RADIUS_TILES}) exceeds VIEW_RADIUS_TILES (${VIEW_RADIUS_TILES}): a chat message could arrive for a player the client has no state for`,
    );
  });

  // (4) Regression: widening the view radius to 19 outran plaza's old open space, so a load-
  //     test / proximity scenario could no longer put two players a full radius apart on one
  //     row. Any map narrower than the radius makes the radius untestable in it.
  it("plaza has a row with a walkable run longer than VIEW_RADIUS_TILES", () => {
    const map = maps.get("plaza");
    assert.ok(map, "plaza map not loaded");

    const required = VIEW_RADIUS_TILES + 2;
    const longest = longestWalkableRun(map);
    assert.ok(
      longest.length >= required,
      `plaza's longest walkable row run is ${longest.length} tiles (row ${longest.tileY}, from x=${longest.startX}); ` +
        `VIEW_RADIUS_TILES ${VIEW_RADIUS_TILES} needs at least ${required}`,
    );
  });
});

/**
 * Negative control. A geometry check that scans real map data is worthless if it cannot fail,
 * and "0 violations" reads the same whether the band is clean or the scan is broken. These
 * feed deliberately-broken maps through the same loader and the same two helpers.
 */
describe("map ↔ camera invariants — the checkers themselves", () => {
  let fixturesDirectory: string;

  before(async () => {
    fixturesDirectory = await mkdtemp(join(tmpdir(), "zep-camera-invariant-"));
  });

  after(async () => {
    await rm(fixturesDirectory, { recursive: true, force: true });
  });

  const WALL_GID = 9;

  /** A map whose every cell is a wall except the ones listed, which are left walkable. */
  async function mapWithWalkable(
    name: string,
    widthInTiles: number,
    heightInTiles: number,
    walkable: readonly (readonly [number, number])[],
  ): Promise<CollisionMap> {
    const data = new Array<number>(widthInTiles * heightInTiles).fill(WALL_GID);
    for (const [tileX, tileY] of walkable) {
      data[tileY * widthInTiles + tileX] = 0;
    }
    const contents = {
      width: widthInTiles,
      height: heightInTiles,
      tilesets: [
        {
          firstgid: 1,
          tilecount: 16,
          tiles: [{ id: 8, properties: [{ name: "collides", type: "bool", value: true }] }],
        },
      ],
      layers: [{ name: "collision", type: "tilelayer", data }],
    };
    await writeFile(join(fixturesDirectory, `${name}.json`), JSON.stringify(contents), "utf8");
    return new TiledMapLoader(fixturesDirectory).load(name);
  }

  /** Same dimensions as plaza, so the band offsets under test are the production ones. */
  const WIDTH = 64;
  const HEIGHT = 35;

  it("reports one violation per side when a walkable tile is planted in each band", async () => {
    const planted = [
      ["left", [BORDER.left - 1, HEIGHT >> 1]],
      ["right", [WIDTH - BORDER.right, HEIGHT >> 1]],
      ["top", [WIDTH >> 1, BORDER.top - 1]],
      ["bottom", [WIDTH >> 1, HEIGHT - BORDER.bottom]],
    ] as const;

    for (const [side, tile] of planted) {
      const map = await mapWithWalkable(`band-${side}`, WIDTH, HEIGHT, [tile]);
      const violations = walkableTilesInBorderBand(map);
      assert.equal(violations.length, 1, `${side}: expected exactly 1 violation`);
      assert.equal(violations[0]?.side, side, `${side}: classified as ${violations[0]?.side}`);
      assert.deepEqual([violations[0]?.tileX, violations[0]?.tileY], [tile[0], tile[1]]);
    }
  });

  it("passes a walkable tile just inside each band edge — the band is not off by one", async () => {
    const insideCorners = [
      [BORDER.left, BORDER.top],
      [WIDTH - BORDER.right - 1, HEIGHT - BORDER.bottom - 1],
    ] as const;
    const map = await mapWithWalkable("band-inside", WIDTH, HEIGHT, insideCorners);
    assert.deepEqual(walkableTilesInBorderBand(map), []);
  });

  it("measures a walkable run and so can fail assertion (4)", async () => {
    const row = HEIGHT >> 1;
    const short = VIEW_RADIUS_TILES + 1;
    const tiles: [number, number][] = [];
    for (let offset = 0; offset < short; offset++) {
      tiles.push([BORDER.left + offset, row]);
    }
    const map = await mapWithWalkable("short-run", WIDTH, HEIGHT, tiles);
    const longest = longestWalkableRun(map);
    assert.equal(longest.length, short);
    assert.equal(longest.tileY, row);
    assert.ok(longest.length < VIEW_RADIUS_TILES + 2, "this map must fail the plaza run check");
  });

  it("does not join a run across a row boundary", async () => {
    // Last walkable column of one row and first of the next: 1 + 1, never 2.
    const map = await mapWithWalkable("row-wrap", WIDTH, HEIGHT, [
      [WIDTH - 1, 10],
      [0, 11],
    ]);
    assert.equal(longestWalkableRun(map).length, 1);
  });
});
