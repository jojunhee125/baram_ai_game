// Rebuilds the tileset and avatar sheet under code/assets from a local checkout of the
// Ninja Adventure Pack (github.com/pixel-boy/NinjaAdventure, CC0). See code/assets/README.md.
//
//   node tools/import-ninja-assets.mjs <ninja-adventure-repo-root>     (cwd = code/)
//   NINJA_ASSET_ROOT=<...> node tools/import-ninja-assets.mjs
//
// Sources are 16px native art; every frame is cropped on the 16px grid and scaled 2x with
// nearest-neighbour so the pixel edges stay hard at our 32px tile size.
import { deflateSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS_DIR = resolve(fileURLToPath(new URL("../assets", import.meta.url)));
const SRC_TILE = 16;
const TILE = 32;
const SCALE = TILE / SRC_TILE;

/* ---------------------------------------------------------------- png ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(canvas) {
  const stride = canvas.width * 4;
  const raw = Buffer.alloc((stride + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const at = y * (stride + 1);
    raw[at] = 0;
    canvas.data.copy(raw, at + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.width, 0);
  ihdr.writeUInt32BE(canvas.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses the per-scanline PNG filters (spec 9.2) for 8-bit RGBA, i.e. 4 bytes per pixel. */
function unfilter(raw, width, height, label) {
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) {
    throw new Error(`${label}: inflated to ${raw.length} bytes, expected ${(stride + 1) * height}`);
  }
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const from = y * (stride + 1);
    const filter = raw[from];
    const row = y * stride;
    const prior = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? out[row + x - bpp] : 0;
      const up = y > 0 ? out[prior + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[prior + x - bpp] : 0;
      const value = raw[from + 1 + x];
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`${label}: unsupported filter type ${filter} on row ${y}`);
      }
      out[row + x] = restored & 0xff;
    }
  }
  return out;
}

function decodePng(buffer, label) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label}: not a PNG file`);
  }
  let header = null;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === "IDAT") {
      // Encoders split the pixel stream across several IDATs; only their concatenation inflates.
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error(`${label}: no IHDR chunk`);
  if (idat.length === 0) throw new Error(`${label}: no IDAT chunk`);
  if (header.bitDepth !== 8 || header.colorType !== 6) {
    throw new Error(
      `${label}: expected bitdepth 8 / colortype 6 (RGBA), got ${header.bitDepth}/${header.colorType}`,
    );
  }
  if (header.interlace !== 0) throw new Error(`${label}: interlaced PNGs are not supported`);
  if (header.compression !== 0 || header.filter !== 0) {
    throw new Error(`${label}: unsupported compression/filter method`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  return new Canvas(header.width, header.height, unfilter(raw, header.width, header.height, label));
}

/* ------------------------------------------------------------- canvas ---- */

class Canvas {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data ?? Buffer.alloc(width * height * 4);
  }

  at(x, y) {
    return (y * this.width + x) * 4;
  }

  /** Copies every channel, alpha included, so transparent padding stays transparent. */
  blit(source, x, y) {
    for (let dy = 0; dy < source.height; dy += 1) {
      source.data.copy(
        this.data,
        this.at(x, y + dy),
        source.at(0, dy),
        source.at(0, dy) + source.width * 4,
      );
    }
  }
}

function crop(source, x, y, width, height, label) {
  if (x < 0 || y < 0 || x + width > source.width || y + height > source.height) {
    throw new Error(
      `${label}: crop ${width}x${height} at (${x},${y}) is outside the ${source.width}x${source.height} source`,
    );
  }
  const out = new Canvas(width, height);
  for (let dy = 0; dy < height; dy += 1) {
    source.data.copy(out.data, out.at(0, dy), source.at(x, y + dy), source.at(x + width, y + dy));
  }
  return out;
}

/** Crops one cell of the source's 16px grid; `col`/`row` are 0-indexed cell coordinates. */
function cell(source, col, row) {
  return crop(source, col * SRC_TILE, row * SRC_TILE, SRC_TILE, SRC_TILE, source.label ?? "source");
}

/** Places an undersized prop on a transparent 16x16 cell at the given offset. */
function pad(source, offsetX, offsetY) {
  if (source.width + offsetX > SRC_TILE || source.height + offsetY > SRC_TILE) {
    throw new Error(
      `${source.label ?? "source"}: ${source.width}x${source.height} at (${offsetX},${offsetY}) overflows a ${SRC_TILE}px cell`,
    );
  }
  const out = new Canvas(SRC_TILE, SRC_TILE);
  out.blit(source, offsetX, offsetY);
  return out;
}

/**
 * Repeats a horizontal slice of `source` down a whole cell. `height` must divide SRC_TILE so
 * the tile edge lands on a repeat boundary; the seam is then an adjacency the art already
 * contains, which is what lets one tile run in any direction.
 */
function tileRows(source, y, height) {
  if (SRC_TILE % height !== 0) {
    throw new Error(`tileRows: ${height} does not divide the ${SRC_TILE}px cell`);
  }
  const strip = crop(source, 0, y, SRC_TILE, height, source.label ?? "source");
  const out = new Canvas(SRC_TILE, SRC_TILE);
  for (let dy = 0; dy < SRC_TILE; dy += height) out.blit(strip, 0, dy);
  return out;
}

/** Straight-alpha source-over: `over` is drawn on top of a copy of `base`. */
function composite(base, over) {
  if (base.width !== over.width || base.height !== over.height) {
    throw new Error("composite: layers must have the same size");
  }
  const out = new Canvas(base.width, base.height, Buffer.from(base.data));
  for (let i = 0; i < out.data.length; i += 4) {
    const srcAlpha = over.data[i + 3];
    if (srcAlpha === 0) continue;
    if (srcAlpha === 255) {
      over.data.copy(out.data, i, i, i + 4);
      continue;
    }
    const src = srcAlpha / 255;
    const dst = (out.data[i + 3] / 255) * (1 - src);
    const alpha = src + dst;
    for (let c = 0; c < 3; c += 1) {
      out.data[i + c] = Math.round((over.data[i + c] * src + out.data[i + c] * dst) / alpha);
    }
    out.data[i + 3] = Math.round(alpha * 255);
  }
  return out;
}

/** Exact RGB substitution; alpha is never read or written, so anti-aliased edges survive. */
function recolor(source, pairs) {
  const out = new Canvas(source.width, source.height, Buffer.from(source.data));
  let replaced = 0;
  for (let i = 0; i < out.data.length; i += 4) {
    for (const [from, to] of pairs) {
      if (out.data[i] === from[0] && out.data[i + 1] === from[1] && out.data[i + 2] === from[2]) {
        out.data[i] = to[0];
        out.data[i + 1] = to[1];
        out.data[i + 2] = to[2];
        replaced += 1;
        break;
      }
    }
  }
  if (replaced === 0) throw new Error("recolor: none of the source colours were found");
  return out;
}

/** Nearest-neighbour only — any interpolation would blur the pixel art. */
function upscale(source, factor) {
  const out = new Canvas(source.width * factor, source.height * factor);
  for (let y = 0; y < out.height; y += 1) {
    const srcRow = Math.floor(y / factor);
    for (let x = 0; x < out.width; x += 1) {
      const from = source.at(Math.floor(x / factor), srcRow);
      source.data.copy(out.data, out.at(x, y), from, from + 4);
    }
  }
  return out;
}

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
  ninjaBlue: "content/character/ninja_blue/sprite.png",
  samuraiBlue: "content/character/samurai_blue/sprite.png",
  samuraiGreen: "content/character/samurai_green/samurai_green.png",
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

/* ------------------------------------------------------------- avatar ---- */

/** ninja_blue's two cloth tones, restated in crimson for the fourth skin. */
const CRIMSON_RECOLOR = [
  [
    [121, 184, 206],
    [214, 116, 110],
  ],
  [
    [95, 113, 96],
    [120, 68, 72],
  ],
];

/** Index is the skin id; must stay in sync with AVATAR_SKIN_COUNT in shared/src/constants.ts. */
const SKINS = [
  { label: "ninja_blue", source: "ninjaBlue", recolor: null },
  { label: "samurai_blue", source: "samuraiBlue", recolor: null },
  { label: "samurai_green", source: "samuraiGreen", recolor: null },
  { label: "ninja_crimson", source: "ninjaBlue", recolor: CRIMSON_RECOLOR },
];

const SOURCE_HFRAMES = 4;
const SOURCE_VFRAMES = 7;

/** Our Direction enum (Down, Left, Right, Up) -> the source sheet's column. */
const SRC_COL_FOR_DIR = [0, 2, 3, 1];
/** Our frame columns (stepA, idle, stepB) -> the source sheet's animation row. */
const SRC_ROW_FOR_FRAME = [1, 0, 3];

function buildAvatarSheet(sources) {
  const sheet = new Canvas(
    SRC_ROW_FOR_FRAME.length * TILE,
    SKINS.length * SRC_COL_FOR_DIR.length * TILE,
  );
  SKINS.forEach((skin, skinIndex) => {
    const source = sources[skin.source];
    if (
      source.width !== SOURCE_HFRAMES * SRC_TILE ||
      source.height !== SOURCE_VFRAMES * SRC_TILE
    ) {
      throw new Error(
        `${skin.label}: expected a ${SOURCE_HFRAMES}x${SOURCE_VFRAMES} frame sheet, got ${source.width}x${source.height}`,
      );
    }
    SRC_COL_FOR_DIR.forEach((sourceCol, direction) => {
      SRC_ROW_FOR_FRAME.forEach((sourceRow, frameCol) => {
        let frame = cell(source, sourceCol, sourceRow);
        if (skin.recolor) frame = recolor(frame, skin.recolor);
        sheet.blit(
          upscale(frame, SCALE),
          frameCol * TILE,
          (skinIndex * SRC_COL_FOR_DIR.length + direction) * TILE,
        );
      });
    });
  });
  return sheet;
}

/* ---------------------------------------------------------------- map ---- */

/** Tiled's top 3 gid bits are flip/rotation flags; mirrors GID_TILE_MASK in server/src/game/tiledMap.ts. */
const GID_TILE_MASK = 0x1fffffff;

/** Every map that depends on this tileset; each is re-verified and re-emitted unchanged. */
const MAP_FILES = ["maps/plaza.json", "maps/grand-plaza.json"];

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
const avatar = buildAvatarSheet(sources);
const maps = MAP_FILES.map((file) => ({ file, contents: verifyMapContract(tileset, file) }));
for (const { file, contents } of maps) {
  console.log(`verified ${file} against the tileset (${contents.length} bytes, unchanged)`);
}

write("tilesets/plaza-tiles.png", encodePng(tileset));
console.log(`  ${TILE_RECIPES.length} tiles, ${tileset.width}x${tileset.height}`);

write("sprites/avatar.png", encodePng(avatar));
console.log(`  ${SKINS.length} skins (${SKINS.map((s) => s.label).join(", ")}), ${avatar.width}x${avatar.height}`);

// Re-emitted byte for byte from what was just verified - assets/README.md documents that this
// pipeline never changes the maps.
for (const { file, contents } of maps) write(file, contents);
