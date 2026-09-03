// Rebuilds the tileset under code/assets from a local checkout of the Ninja Adventure Pack
// (github.com/pixel-boy/NinjaAdventure, CC0). See code/assets/README.md.
//
//   node tools/import-ninja-assets.mjs <ninja-adventure-repo-root>     (cwd = code/)
//   NINJA_ASSET_ROOT=<...> node tools/import-ninja-assets.mjs
//
// Sources are 16px native art; every frame is cropped on the 16px grid and scaled 2x with
// nearest-neighbour so the pixel edges stay hard at our 32px tile size.
//
// The character sheet does NOT come from this pack: assets/sprites/avatar.png is built by
// tools/import-avatar.mjs from the Tiny Characters Set. This script never touches it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Canvas,
  SCALE,
  SRC_TILE,
  TILE,
  cell,
  composite,
  decodePng,
  encodePng,
  pad,
  tileRows,
  upscale,
} from "./lib/png.mjs";

const ASSETS_DIR = resolve(fileURLToPath(new URL("../assets", import.meta.url)));

/* -------------------------------------------------------------- input ---- */

const SOURCE_FILES = {
  interiorFloor: "content/map/tileset_interior_floor.png",
  floor: "content/map/tileset_floor.png",
  animated: "content/map/tileset_animated.png",
  wallSimple: "content/map/tileset_wall_simple.png",
  villageAbandoned: "content/map/tileset_village_abandoned.png",
  grass: "content/destroyable/grass.png",
  crate: "content/destroyable/crate.png",
  pot: "content/destroyable/pot.png",
};

function resolveSourceRoot() {
  const raw = process.argv[2] ?? process.env.NINJA_ASSET_ROOT;
  if (!raw) {
    console.error("usage: node tools/import-ninja-assets.mjs <ninja-adventure-repo-root>");
    console.error("       (or set NINJA_ASSET_ROOT to the same path)");
    console.error("expects a checkout of github.com/pixel-boy/NinjaAdventure containing content/");
    process.exit(1);
  }
  return resolve(raw);
}

function loadSources(root) {
  const missing = Object.values(SOURCE_FILES).filter((file) => !existsSync(join(root, file)));
  if (missing.length > 0) {
    console.error(`missing ${missing.length} source file(s) under ${root}:`);
    for (const file of missing) console.error(`  ${file}`);
    process.exit(1);
  }
  const sources = {};
  for (const [key, file] of Object.entries(SOURCE_FILES)) {
    const canvas = decodePng(readFileSync(join(root, file)), file);
    canvas.label = file;
    sources[key] = canvas;
  }
  return sources;
}

/* ------------------------------------------------------------ tileset ---- */

const TILESET_COLUMNS = 8;
const FIRST_BLOCKING_TILE_ID = 8;

/**
 * Tile 8 runs along all four sides of the map and tile 9 sits on all four corners, so the wall
 * has to read the same in every direction. tileset_wall_simple is drawn in 3/4 perspective and
 * only tiles along one axis, so we keep just its two brick courses - rows 6-13 of cell (3,6) -
 * and repeat them. That strip is 8px-periodic on both axes, so the 16px tile edge lands on a
 * repeat boundary and stays invisible horizontally, vertically and at the corners. A dedicated
 * corner tile is not possible here: one id covers all four corners, so it would fit one of them
 * and be mirrored wrong on the other three.
 */
const brickMasonry = (s) => tileRows(cell(s.wallSimple, 3, 6), 6, 8);

/** Index is the tile id; gid is id + 1. `collides` mirrors the id >= 8 rule the map relies on. */
const TILE_RECIPES = [
  { label: "interior floor", collides: false, build: (s) => cell(s.interiorFloor, 1, 1) },
  { label: "interior floor cracked", collides: false, build: (s) => cell(s.interiorFloor, 3, 3) },
  { label: "grass", collides: false, build: (s) => cell(s.floor, 15, 12) },
  { label: "wood deck", collides: false, build: (s) => cell(s.interiorFloor, 14, 1) },
  { label: "dirt path", collides: false, build: (s) => cell(s.floor, 12, 19) },
  { label: "medallion", collides: false, build: (s) => cell(s.interiorFloor, 14, 9) },
  { label: "sand", collides: false, build: (s) => cell(s.floor, 1, 4) },
  {
    label: "grass with flowers",
    collides: false,
    build: (s) => composite(cell(s.floor, 15, 12), cell(s.animated, 0, 0)),
  },
  { label: "wall, brick masonry", collides: true, build: brickMasonry },
  { label: "wall, brick masonry corner", collides: true, build: brickMasonry },
  { label: "tree stump", collides: true, build: (s) => cell(s.villageAbandoned, 6, 8) },
  { label: "bush", collides: true, build: (s) => s.grass },
  { label: "water", collides: true, build: (s) => cell(s.floor, 5, 22) },
  { label: "crate", collides: true, build: (s) => pad(s.crate, 1, 1) },
  { label: "pot", collides: true, build: (s) => pad(s.pot, 1, 0) },
  { label: "mossy rocks", collides: true, build: (s) => cell(s.villageAbandoned, 10, 4) },
];

function buildTileset(sources) {
  const rows = Math.ceil(TILE_RECIPES.length / TILESET_COLUMNS);
  const sheet = new Canvas(TILESET_COLUMNS * TILE, rows * TILE);
  TILE_RECIPES.forEach((recipe, id) => {
    if (recipe.collides !== id >= FIRST_BLOCKING_TILE_ID) {
      throw new Error(
        `tile ${id} (${recipe.label}): collides=${recipe.collides} contradicts the id >= ${FIRST_BLOCKING_TILE_ID} rule`,
      );
    }
    const source = recipe.build(sources);
    if (source.width !== SRC_TILE || source.height !== SRC_TILE) {
      throw new Error(
        `tile ${id} (${recipe.label}): expected a ${SRC_TILE}x${SRC_TILE} cell, got ${source.width}x${source.height}`,
      );
    }
    sheet.blit(
      upscale(source, SCALE),
      (id % TILESET_COLUMNS) * TILE,
      Math.floor(id / TILESET_COLUMNS) * TILE,
    );
  });
  return sheet;
}

/* ---------------------------------------------------------------- map ---- */

/** Tiled's top 3 gid bits are flip/rotation flags; mirrors GID_TILE_MASK in server/src/game/tiledMap.ts. */
const GID_TILE_MASK = 0x1fffffff;

/** Every map that depends on this tileset; each is re-verified and re-emitted unchanged. */
const MAP_FILES = [
  "maps/plaza.json",
  "maps/grand-plaza.json",
  "maps/hunting-ground.json",
  "maps/hunting-den.json",
];

/**
 * The maps are authored art-independently: only the PNG changes on a reskin. Rather than
 * regenerate them we re-assert every contract they make about the tileset and hand the original
 * bytes back for re-emission, so a reskin that broke one of them cannot pass unnoticed.
 * Read-only: this must run before anything is written, or a broken reskin fails with the
 * assets already half-overwritten.
 */
function verifyMapContract(tileset, mapFile) {
  const original = readFileSync(resolve(ASSETS_DIR, mapFile));
  const map = JSON.parse(original.toString("utf8"));

  const expect = (actual, wanted, what) => {
    if (actual !== wanted) throw new Error(`${mapFile}: ${what} is ${actual}, expected ${wanted}`);
  };

  expect(map.tilewidth, TILE, "tilewidth");
  expect(map.tileheight, TILE, "tileheight");
  expect(map.tilesets?.length, 1, "tileset count");

  const [entry] = map.tilesets;
  expect(entry.image, "../tilesets/plaza-tiles.png", "tileset image");
  expect(entry.firstgid, 1, "firstgid");
  expect(entry.columns, TILESET_COLUMNS, "tileset columns");
  expect(entry.tilecount, TILE_RECIPES.length, "tilecount");
  expect(entry.tilewidth, TILE, "tileset tilewidth");
  expect(entry.tileheight, TILE, "tileset tileheight");
  expect(entry.imagewidth, tileset.width, "tileset imagewidth");
  expect(entry.imageheight, tileset.height, "tileset imageheight");

  const blocking = TILE_RECIPES.map((recipe, id) => ({ recipe, id })).filter(({ recipe }) => recipe.collides);
  expect(
    (entry.tiles ?? []).filter((tile) => tile.properties?.some((p) => p.name === "collides" && p.value === true)).length,
    blocking.length,
    "collides tile count",
  );
  for (const { recipe, id } of blocking) {
    const tile = (entry.tiles ?? []).find((candidate) => candidate.id === id);
    if (!tile) throw new Error(`${mapFile}: tile ${id} (${recipe.label}) is missing its collides property`);
  }

  for (const layer of map.layers) {
    // Only tile layers carry `data`; an objectgroup/imagelayer would have none.
    if (layer.type !== "tilelayer") continue;
    for (const raw of layer.data) {
      if (!Number.isInteger(raw) || raw < 0) {
        throw new Error(`${mapFile}: layer "${layer.name}" holds ${String(raw)}, which is not a gid`);
      }
      // Decoded exactly like the server's MapLoader: clear the flip flags (H/V/diagonal) first,
      // otherwise a flipped tile reads as a huge gid and gets rejected here for no reason.
      const gid = raw & GID_TILE_MASK;
      if (gid > TILE_RECIPES.length) {
        throw new Error(
          `${mapFile}: layer "${layer.name}" references gid ${raw} (tile gid ${gid}), outside 0..${TILE_RECIPES.length}`,
        );
      }
    }
  }

  return original;
}

/* --------------------------------------------------------------- emit ---- */

function write(relativePath, contents) {
  const target = resolve(ASSETS_DIR, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  console.log(`wrote ${relativePath} (${contents.length} bytes)`);
}

const root = resolveSourceRoot();
console.log(`reading ${Object.keys(SOURCE_FILES).length} source files from ${root}`);
const sources = loadSources(root);

// Build and verify everything in memory before the first byte lands: a failure here has to
// leave assets/ exactly as it was, not half-reskinned.
const tileset = buildTileset(sources);
const maps = MAP_FILES.map((file) => ({ file, contents: verifyMapContract(tileset, file) }));
for (const { file, contents } of maps) {
  console.log(`verified ${file} against the tileset (${contents.length} bytes, unchanged)`);
}

write("tilesets/plaza-tiles.png", encodePng(tileset));
console.log(`  ${TILE_RECIPES.length} tiles, ${tileset.width}x${tileset.height}`);

// Re-emitted byte for byte from what was just verified - assets/README.md documents that this
// pipeline never changes the maps.
for (const { file, contents } of maps) write(file, contents);
