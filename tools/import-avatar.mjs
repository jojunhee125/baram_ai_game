// Rebuilds assets/sprites/avatar.png from the Tiny Characters Set (Fleurman, CC0) checked in
// under tools/art-source/. See tools/art-source/tiny-characters-set/SOURCE.md for provenance.
//
//   node tools/import-avatar.mjs [path-to-tiny_characters_set.png]     (cwd = code/)
//
// The source is 16px native art; every frame is cropped on the 16px grid and scaled 2x with
// nearest-neighbour so the pixel edges stay hard at our 32px tile size. The run is deterministic:
// no randomness, no timestamps, so two runs produce byte-identical output.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Canvas, SCALE, SRC_TILE, TILE, cell, decodePng, encodePng, upscale } from "./lib/png.mjs";

const ASSETS_DIR = resolve(fileURLToPath(new URL("../assets", import.meta.url)));
const SHARED_CONSTANTS = resolve(fileURLToPath(new URL("../shared/src/constants.ts", import.meta.url)));
const DEFAULT_SOURCE = resolve(
  fileURLToPath(new URL("./art-source/tiny-characters-set/tiny_characters_set.png", import.meta.url)),
);

/* -------------------------------------------------------------- source ---- */

/**
 * The sheet is a 18x16 grid of 16px cells holding 24 characters, each a 3x4 block:
 * columns are animation frames, rows are facings. Block (bx,by) therefore starts at
 * cell (bx*3, by*4).
 */
const SOURCE_CELLS_X = 18;
const SOURCE_CELLS_Y = 16;
const BLOCK_COLS = 3;
const BLOCK_ROWS = 4;
const BLOCKS_X = SOURCE_CELLS_X / BLOCK_COLS;
const BLOCKS_Y = SOURCE_CELLS_Y / BLOCK_ROWS;

/** Rows within a block, in source order. */
const SRC_ROW_DOWN = 0;
const SRC_ROW_RIGHT = 1;
const SRC_ROW_UP = 2;
const SRC_ROW_LEFT = 3;

/**
 * Our Direction enum (shared/src/geometry.ts: Down=0, Left=1, Right=2, Up=3) -> the block's row.
 * Indexed by direction, so the order below is Down, Left, Right, Up.
 */
const SRC_ROW_FOR_DIR = [SRC_ROW_DOWN, SRC_ROW_LEFT, SRC_ROW_RIGHT, SRC_ROW_UP];

/**
 * Our frame columns (stepA, idle, stepB) -> the block's column. Identity: the source already
 * stores idle in the middle with a distinct step pose on either side — the two steps are drawn
 * separately, not mirrored, so neither can be dropped or reused.
 */
const FRAME_COLS = [0, 1, 2];

/**
 * Index is the skin id; `block` is the (bx,by) character block on the source sheet. Must stay in
 * sync with AVATAR_SKIN_COUNT in shared/src/constants.ts — asserted below, not just documented.
 * Every skin is a separately drawn character: this pipeline does no recolouring.
 */
const SKINS = [
  { label: "brown long hair, red top", block: [0, 0] },
  { label: "blond, green tunic", block: [3, 0] },
  { label: "red twintails, blue dress", block: [2, 0] },
  { label: "dark skin afro, pink top", block: [5, 2] },
];

/* --------------------------------------------------------------- build ---- */

function loadSource() {
  const path = resolve(process.argv[2] ?? DEFAULT_SOURCE);
  if (!existsSync(path)) {
    console.error(`missing source sheet: ${path}`);
    console.error("expects the Tiny Characters Set PNG; see tools/art-source/*/SOURCE.md");
    process.exit(1);
  }
  const canvas = decodePng(readFileSync(path), path);
  if (
    canvas.width !== SOURCE_CELLS_X * SRC_TILE ||
    canvas.height !== SOURCE_CELLS_Y * SRC_TILE
  ) {
    throw new Error(
      `${path}: expected a ${SOURCE_CELLS_X * SRC_TILE}x${SOURCE_CELLS_Y * SRC_TILE} sheet, got ${canvas.width}x${canvas.height}`,
    );
  }
  canvas.label = path;
  return { path, canvas };
}

/** Guards against a typo in SKINS silently shipping a sheet the client cannot index. */
function assertSkinCountMatchesShared() {
  const source = readFileSync(SHARED_CONSTANTS, "utf8");
  const match = /AVATAR_SKIN_COUNT\s*=\s*(\d+)/.exec(source);
  if (!match) throw new Error(`${SHARED_CONSTANTS}: AVATAR_SKIN_COUNT not found`);
  if (Number(match[1]) !== SKINS.length) {
    throw new Error(
      `AVATAR_SKIN_COUNT is ${match[1]} but this importer builds ${SKINS.length} skins`,
    );
  }
}

function buildAvatarSheet(source) {
  const sheet = new Canvas(
    FRAME_COLS.length * TILE,
    SKINS.length * SRC_ROW_FOR_DIR.length * TILE,
  );
  SKINS.forEach((skin, skinIndex) => {
    const [blockX, blockY] = skin.block;
    if (blockX < 0 || blockY < 0 || blockX >= BLOCKS_X || blockY >= BLOCKS_Y) {
      throw new Error(
        `skin ${skinIndex} (${skin.label}): block (${blockX},${blockY}) is outside the ${BLOCKS_X}x${BLOCKS_Y} block grid`,
      );
    }
    SRC_ROW_FOR_DIR.forEach((blockRow, direction) => {
      FRAME_COLS.forEach((blockCol, frameCol) => {
        const frame = cell(source, blockX * BLOCK_COLS + blockCol, blockY * BLOCK_ROWS + blockRow);
        sheet.blit(
          upscale(frame, SCALE),
          frameCol * TILE,
          (skinIndex * SRC_ROW_FOR_DIR.length + direction) * TILE,
        );
      });
    });
  });
  return sheet;
}

/* -------------------------------------------------------------- verify ---- */

function rowBytes(sheet, row) {
  const stride = sheet.width * 4;
  return sheet.data.subarray(row * TILE * stride, (row + 1) * TILE * stride);
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Everything the client assumes about this sheet, re-checked on every run: the layout the
 * spritesheet loader slices by, no blank frames, and — since the whole point of the reskin was
 * dropping the recoloured duplicate — four genuinely different characters.
 */
function verifySheet(sheet) {
  const expectedWidth = FRAME_COLS.length * TILE;
  const expectedHeight = SKINS.length * SRC_ROW_FOR_DIR.length * TILE;
  if (sheet.width !== expectedWidth || sheet.height !== expectedHeight) {
    throw new Error(
      `avatar sheet is ${sheet.width}x${sheet.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }

  const rows = SKINS.length * SRC_ROW_FOR_DIR.length;
  const DIR_LABELS = ["down", "left", "right", "up"];
  for (let row = 0; row < rows; row += 1) {
    const bytes = rowBytes(sheet, row);
    let opaque = 0;
    for (let i = 3; i < bytes.length; i += 4) if (bytes[i] !== 0) opaque += 1;
    if (opaque === 0) {
      const skin = Math.floor(row / SRC_ROW_FOR_DIR.length);
      throw new Error(
        `row ${row} (skin ${skin} "${SKINS[skin].label}", facing ${DIR_LABELS[row % 4]}) is fully transparent`,
      );
    }
  }

  // Per skin: the four facings must not be the same pixels, or the character would never turn.
  SKINS.forEach((skin, skinIndex) => {
    const perDirection = SRC_ROW_FOR_DIR.map((_, direction) =>
      digest(rowBytes(sheet, skinIndex * SRC_ROW_FOR_DIR.length + direction)),
    );
    if (new Set(perDirection).size !== perDirection.length) {
      throw new Error(`skin ${skinIndex} (${skin.label}): two facings are pixel-identical`);
    }
  });

  // Across skins: distinct art, not one character recoloured.
  const perSkin = SKINS.map((_, skinIndex) =>
    digest(
      sheet.data.subarray(
        skinIndex * SRC_ROW_FOR_DIR.length * TILE * sheet.width * 4,
        (skinIndex + 1) * SRC_ROW_FOR_DIR.length * TILE * sheet.width * 4,
      ),
    ),
  );
  if (new Set(perSkin).size !== perSkin.length) {
    throw new Error("two skins are pixel-identical");
  }
  return perSkin;
}

/* ---------------------------------------------------------------- emit ---- */

const { path, canvas } = loadSource();
console.log(`reading ${path} (${canvas.width}x${canvas.height})`);

assertSkinCountMatchesShared();

// Build and verify in memory before the first byte lands: a failed reskin has to leave
// assets/sprites/avatar.png exactly as it was, not half-overwritten.
const avatar = buildAvatarSheet(canvas);
const skinDigests = verifySheet(avatar);

const target = resolve(ASSETS_DIR, "sprites/avatar.png");
const encoded = encodePng(avatar);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, encoded);

console.log(`wrote sprites/avatar.png (${encoded.length} bytes, ${avatar.width}x${avatar.height})`);
console.log(`  sha256 ${digest(encoded)}`);
SKINS.forEach((skin, index) => {
  console.log(
    `  skin ${index}: block (${skin.block[0]},${skin.block[1]}) ${skin.label} — pixels ${skinDigests[index].slice(0, 12)}`,
  );
});
