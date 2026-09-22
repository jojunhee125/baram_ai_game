import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { CollisionMap } from "../rooms/contracts";
import { TiledMapLoader } from "./tiledMap";

describe("TiledMapLoader.load — the real plaza map", () => {
  let map: CollisionMap;

  before(async () => {
    map = await new TiledMapLoader().load("plaza");
  });

  it("resolves assets/maps/plaza.json from the default directory", () => {
    assert.equal(map.widthInTiles, 64);
    assert.equal(map.heightInTiles, 35);
  });

  it("treats an empty collision cell (gid 0) as walkable", () => {
    // (16,8) is the map's first gid-0 cell: the north-west corner of the walkable interior.
    assert.equal(map.isWalkable(16, 8), true);
  });

  it("blocks a cell for every collides tile id in the tileset", () => {
    const blockedCells = [
      { tileId: 8, tileX: 11, tileY: 5 },
      { tileId: 9, tileX: 15, tileY: 7 },
      { tileId: 10, tileX: 3, tileY: 2 },
      { tileId: 11, tileX: 2, tileY: 1 },
      { tileId: 12, tileX: 0, tileY: 0 },
      { tileId: 13, tileX: 13, tileY: 5 },
      { tileId: 14, tileX: 12, tileY: 6 },
      { tileId: 15, tileX: 4, tileY: 1 },
    ];
    for (const { tileId, tileX, tileY } of blockedCells) {
      assert.equal(
        map.isWalkable(tileX, tileY),
        false,
        `tile id ${tileId} at (${tileX}, ${tileY}) should be blocked`,
      );
    }
  });

  it("counts 498 walkable tiles out of 2240 in the south-gate village", () => {
    let walkable = 0;
    for (let tileY = 0; tileY < map.heightInTiles; tileY++) {
      for (let tileX = 0; tileX < map.widthInTiles; tileX++) {
        if (map.isWalkable(tileX, tileY)) {
          walkable++;
        }
      }
    }
    assert.equal(walkable, 498);
  });

  it("walls off the entire perimeter", () => {
    for (let tileX = 0; tileX < map.widthInTiles; tileX++) {
      assert.equal(map.isWalkable(tileX, 0), false, `top edge (${tileX}, 0)`);
      assert.equal(map.isWalkable(tileX, map.heightInTiles - 1), false, `bottom edge (${tileX})`);
    }
    for (let tileY = 0; tileY < map.heightInTiles; tileY++) {
      assert.equal(map.isWalkable(0, tileY), false, `left edge (0, ${tileY})`);
      assert.equal(map.isWalkable(map.widthInTiles - 1, tileY), false, `right edge (${tileY})`);
    }
  });

  it("keeps the documented spawn tile walkable", () => {
    assert.equal(map.isWalkable(31, 20), true);
  });

  it("reports out-of-bounds coordinates as not walkable", () => {
    for (const [tileX, tileY] of [
      [-1, 0],
      [0, -1],
      [64, 0],
      [0, 35],
      [64, 35],
      [999, 999],
      [-999, -999],
    ] as const) {
      assert.equal(map.isWalkable(tileX, tileY), false, `(${tileX}, ${tileY})`);
    }
  });

});

describe("TiledMapLoader.load — rejected input", () => {
  let fixturesDirectory: string;

  before(async () => {
    fixturesDirectory = await mkdtemp(join(tmpdir(), "zep-tiled-"));
  });

  after(async () => {
    await rm(fixturesDirectory, { recursive: true, force: true });
  });

  function tiledMap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      width: 2,
      height: 2,
      tilesets: [
        {
          firstgid: 1,
          tilecount: 16,
          tiles: [{ id: 8, properties: [{ name: "collides", type: "bool", value: true }] }],
        },
      ],
      layers: [
        { name: "ground", type: "tilelayer", data: [1, 1, 1, 1] },
        { name: "collision", type: "tilelayer", data: [9, 0, 0, 0] },
      ],
      ...overrides,
    };
  }

  async function loadFixture(name: string, contents: unknown): Promise<CollisionMap> {
    const raw = typeof contents === "string" ? contents : JSON.stringify(contents);
    await writeFile(join(fixturesDirectory, `${name}.json`), raw, "utf8");
    return new TiledMapLoader(fixturesDirectory).load(name);
  }

  it("loads the fixture shape it rejects variants of", async () => {
    const map = await loadFixture("valid", tiledMap());
    assert.equal(map.isWalkable(0, 0), false);
    assert.equal(map.isWalkable(1, 0), true);
  });

  it("rejects a mapKey that could escape the maps directory", async () => {
    const loader = new TiledMapLoader(fixturesDirectory);
    for (const mapKey of ["../plaza", "..\\plaza", "a/b", "", "plaza.json", "../../etc/passwd"]) {
      await assert.rejects(loader.load(mapKey), /invalid mapKey/, `mapKey ${JSON.stringify(mapKey)}`);
    }
  });

  it("reports a missing map file with its resolved path", async () => {
    await assert.rejects(
      new TiledMapLoader(fixturesDirectory).load("does-not-exist"),
      /failed to read map "does-not-exist" at .*does-not-exist\.json/,
    );
  });

  it("rejects malformed JSON", async () => {
    await assert.rejects(loadFixture("broken", "{ not json"), /is not valid JSON/);
  });

  it("rejects a map with no collision layer", async () => {
    const contents = tiledMap({ layers: [{ name: "ground", type: "tilelayer", data: [1, 1, 1, 1] }] });
    await assert.rejects(loadFixture("no-collision", contents), /has no "collision" layer/);
  });

  it("rejects base64/compressed layer data instead of silently misreading it", async () => {
    const contents = tiledMap({
      layers: [
        { name: "collision", type: "tilelayer", encoding: "base64", compression: "zlib", data: "eJx=" },
      ],
    });
    await assert.rejects(
      loadFixture("encoded", contents),
      /no plain tile array \(encoding: base64, compression: zlib\)/,
    );
  });

  it("rejects a layer whose cell count contradicts the map size", async () => {
    const contents = tiledMap({
      layers: [{ name: "collision", type: "tilelayer", data: [0, 0, 0] }],
    });
    await assert.rejects(loadFixture("short-layer", contents), /has 3 cells, expected 4/);
  });

  it("rejects a gid outside the embedded tileset", async () => {
    const contents = tiledMap({
      layers: [{ name: "collision", type: "tilelayer", data: [99, 0, 0, 0] }],
    });
    await assert.rejects(loadFixture("bad-gid", contents), /gid 99, outside the embedded tileset/);
  });

  it("rejects an external tileset reference", async () => {
    const contents = tiledMap({ tilesets: [{ source: "plaza-tiles.tsx", firstgid: 1 }] });
    await assert.rejects(loadFixture("external-tileset", contents), /references an external tileset/);
  });

  it("rejects a map that embeds more than one tileset", async () => {
    const contents = tiledMap({
      tilesets: [
        { firstgid: 1, tilecount: 16, tiles: [] },
        { firstgid: 17, tilecount: 16, tiles: [] },
      ],
    });
    await assert.rejects(loadFixture("two-tilesets", contents), /exactly one tileset, found 2/);
  });

  it("rejects a collides tile with an unusable id rather than dropping the wall", async () => {
    const contents = tiledMap({
      tilesets: [
        {
          firstgid: 1,
          tilecount: 16,
          tiles: [{ properties: [{ name: "collides", type: "bool", value: true }] }],
        },
      ],
    });
    await assert.rejects(loadFixture("bad-tile-id", contents), /collides tile with an invalid id/);
  });
});

describe("TiledMapLoader.load — synthetic grids", () => {
  let fixturesDirectory: string;

  before(async () => {
    fixturesDirectory = await mkdtemp(join(tmpdir(), "zep-tiled-grid-"));
  });

  after(async () => {
    await rm(fixturesDirectory, { recursive: true, force: true });
  });

  it("does not let a negative tileX wrap into the previous row", async () => {
    const contents = {
      width: 2,
      height: 2,
      tilesets: [
        {
          firstgid: 1,
          tilecount: 16,
          tiles: [{ id: 8, properties: [{ name: "collides", type: "bool", value: true }] }],
        },
      ],
      // Row 0 is walkable, so an unguarded (-1, 1) would index into it and report true.
      layers: [{ name: "collision", type: "tilelayer", data: [0, 0, 9, 9] }],
    };
    await writeFile(join(fixturesDirectory, "wrap.json"), JSON.stringify(contents), "utf8");

    const map = await new TiledMapLoader(fixturesDirectory).load("wrap");
    assert.equal(map.isWalkable(1, 0), true);
    assert.equal(map.isWalkable(-1, 1), false);
  });

  it("masks Tiled's flip bits off a hand-edited gid", async () => {
    const FLIPPED_HORIZONTALLY = 0x80000000;
    const contents = {
      width: 2,
      height: 1,
      tilesets: [
        {
          firstgid: 1,
          tilecount: 16,
          tiles: [{ id: 8, properties: [{ name: "collides", type: "bool", value: true }] }],
        },
      ],
      layers: [
        { name: "collision", type: "tilelayer", data: [(9 | FLIPPED_HORIZONTALLY) >>> 0, 0] },
      ],
    };
    await writeFile(join(fixturesDirectory, "flipped.json"), JSON.stringify(contents), "utf8");

    const map = await new TiledMapLoader(fixturesDirectory).load("flipped");
    assert.equal(map.isWalkable(0, 0), false);
    assert.equal(map.isWalkable(1, 0), true);
  });
});
