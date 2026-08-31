// Bakes assets/sprites/monster.png and assets/sprites/items.png from the ASCII row arrays below.
//
//   node tools/generate-monster-art.mjs                                (cwd = code/)
//
// Procedural rather than imported, because the repo holds no monster or item art and the CC0
// packs it does hold are fully consumed: all 24 avatar blocks are player skins and the tileset's
// two spare props have no animation frames or facing (docs/design-hunting-inventory.md D-1).
//
// Same shape as tools/generate-assets.mjs' avatar sheet — ASCII rows over a 16px native grid,
// scaled 2x with nearest-neighbour like every other importer here — and the sheet layout is the
// avatar sheet's, character for character, so client/src/world/monsterSprites.ts is
// playerSprites.ts with `skin` renamed to `kindIndex`.
//
// Deterministic: no randomness, no timestamps, so two runs produce byte-identical output. Nothing
// is written until every check below has passed in memory (docs/decisions.md 2026-08-26).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Canvas, SCALE, SRC_TILE, TILE, encodePng, upscale } from "./lib/png.mjs";

const ASSETS_DIR = resolve(fileURLToPath(new URL("../assets", import.meta.url)));
const MONSTER_SPRITES_TS = resolve(
  fileURLToPath(new URL("../client/src/world/monsterSprites.ts", import.meta.url)),
);
const INVENTORY_PANEL_TS = resolve(
  fileURLToPath(new URL("../client/src/ui/inventoryPanel.ts", import.meta.url)),
);

/** Row order inside one kind block; the index matches the shared Direction enum. */
const DIRECTION_ROWS = ["down", "left", "right", "up"];
/** Column order inside one direction row, matching the avatar sheet. */
const FRAME_STEPS = ["stepA", "idle", "stepB"];

/* ------------------------------------------------------------- canvas ---- */

function hex(value) {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
    255,
  ];
}

function setPixel(canvas, x, y, color) {
  if (!color || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const at = canvas.at(x, y);
  canvas.data[at] = color[0];
  canvas.data[at + 1] = color[1];
  canvas.data[at + 2] = color[2];
  canvas.data[at + 3] = color[3];
}

/**
 * Stamps one ASCII block onto a native-resolution cell. `.` leaves whatever is underneath, which
 * is what lets a face decal be drawn over a body pose instead of every pose carrying its own
 * copy of every facing — 6 bodies plus 6 faces instead of 24 hand-drawn frames.
 */
function paintRows(cell, rows, palette, offsetX, offsetY, width, label) {
  if (offsetX + width > SRC_TILE || offsetY + rows.length > SRC_TILE) {
    throw new Error(
      `${label}: ${width}x${rows.length} at (${offsetX},${offsetY}) overflows the ${SRC_TILE}px cell`,
    );
  }
  rows.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(`${label} row ${y}: expected ${width} chars, got ${row.length} ("${row}")`);
    }
    [...row].forEach((ch, x) => {
      if (!(ch in palette)) {
        throw new Error(`${label} row ${y}: unknown palette char "${ch}"`);
      }
      setPixel(cell, offsetX + x, offsetY + y, palette[ch]);
    });
  });
}

function mirror(rows) {
  return rows.map((row) => [...row].reverse().join(""));
}

/* -------------------------------------------------------------- slime ---- */

const SLIME_PALETTE = {
  ".": null,
  o: hex("#1c3a24"),
  g: hex("#58b95c"),
  G: hex("#3d8a45"),
  l: hex("#93dd8e"),
  e: hex("#17281a"),
  w: hex("#eefaec"),
};

/**
 * Squash / neutral / stretch. A slime has no legs to alternate, so the walk cycle is the blob
 * flattening and rebounding; at MONSTER_WALK_FRAME_RATE that reads as hopping between tiles.
 */
const SLIME_BODIES = {
  stepA: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "....oooooooo....",
    "..olllgggggggo..",
    ".ollggggggggggo.",
    "olgggggggggggggo",
    "oggggggggggggggo",
    "oggggggggggggggo",
    "oGGGGGGGGGGGGGGo",
    "oooooooooooooooo",
  ],
  idle: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    ".....oooooo.....",
    "...oollllggoo...",
    "..olllgggggggo..",
    ".ollggggggggggo.",
    ".olgggggggggggo.",
    "oggggggggggggggo",
    "oggggggggggggggo",
    "oggggggggggGGGGo",
    "oGGGGGGGGGGGGGGo",
    ".oooooooooooooo.",
  ],
  stepB: [
    "................",
    "................",
    "................",
    "......oooo......",
    "....oollggoo....",
    "...olllgggggo...",
    "...ollggggggo...",
    "..ollggggggggo..",
    "..olgggggggggo..",
    "..oggggggggggo..",
    ".oggggggggggggo.",
    ".oggggggggggggo.",
    ".oggggggggggggo.",
    ".ogggggggggGGGo.",
    ".oGGGGGGGGGGGGo.",
    "..oooooooooooo..",
  ],
};

const SLIME_FACE_WIDTH = 8;
const SLIME_FACE_X = 4;
/** Where the eyes sit in each pose — the blob's top edge moves, so the face has to move with it. */
const SLIME_FACE_Y = { stepA: 10, idle: 9, stepB: 7 };

const SLIME_FACE_LEFT = ["we.we...", "ee.ee...", "........", ".ooo...."];

/**
 * Up is the only facing with no eyes at all: a slime turned away is a plain blob with two dimples,
 * which is what makes the four rows of a kind visibly different rather than four copies with the
 * highlight nudged (the check at the bottom of this file refuses the latter).
 */
const SLIME_FACES = {
  down: [".we..we.", ".ee..ee.", "........", "..oooo.."],
  left: SLIME_FACE_LEFT,
  right: mirror(SLIME_FACE_LEFT),
  up: ["........", ".GG..GG.", "..G..G..", "........"],
};

/* ---------------------------------------------------------------- bat ---- */

const BAT_PALETTE = {
  ".": null,
  o: hex("#221b30"),
  b: hex("#7d6ba3"),
  B: hex("#574a78"),
  m: hex("#a695cc"),
  e: hex("#f2c05b"),
  f: hex("#f6f2fb"),
};

/**
 * Wings up / spread / down. The body is a narrow four-pixel column so the wings own most of the
 * silhouette — a wide body reads as an owl, and the whole point of these two kinds is that
 * neither can be mistaken for a person at 32px (design D-1).
 *
 * Every pose keeps the head interior at cols 6-9, rows 7-10, so one face offset serves all three.
 * The body stops short of the cell floor: the sprite origin is (0.5, 1) like the avatar's, so that
 * gap is the bat hovering over its tile rather than standing on it.
 *
 * The raised pose drops the ears — they are behind the wings — which is also what makes the
 * tallest and the widest frames of the cycle unmistakable from each other.
 */
const BAT_BODIES = {
  stepA: [
    "................",
    "oo............oo",
    "ommo........ommo",
    "ommmo......ommmo",
    "ommmmo....ommmmo",
    ".ommmo....ommmo.",
    "..omooooooooomo.",
    ".....obbbbo.....",
    ".....obbbbo.....",
    ".....obbbbo.....",
    ".....obbbbo.....",
    ".....oBBBBo.....",
    "......oooo......",
    "................",
    "................",
    "................",
  ],
  idle: [
    "................",
    "................",
    "................",
    "................",
    "......o..o......",
    ".....ob..bo.....",
    "..oo.oooooo.oo..",
    ".omo.obbbbo.omo.",
    "ommmoobbbboommmo",
    "ommmmobbbbommmmo",
    "ommmmobbbbommmmo",
    "ooooooBBBBoooooo",
    "......oooo......",
    "................",
    "................",
    "................",
  ],
  stepB: [
    "................",
    "................",
    "................",
    "................",
    "......o..o......",
    ".....ob..bo.....",
    ".....oooooo.....",
    ".....obbbbo.....",
    "....oobbbboo....",
    "...omobbbbomo...",
    "..ommobbbbommo..",
    ".ommmoBBBBommmo.",
    "ommmo.oooo.ommmo",
    ".oooo......oooo.",
    "................",
    "................",
  ],
};

const BAT_FACE_WIDTH = 4;
const BAT_FACE_X = 6;
const BAT_FACE_Y = 7;

const BAT_FACE_LEFT = ["ee..", "....", "oo..", ".f.."];

const BAT_FACES = {
  down: ["e..e", "....", "oooo", ".ff."],
  left: BAT_FACE_LEFT,
  right: mirror(BAT_FACE_LEFT),
  up: ["....", ".BB.", ".BB.", "...."],
};

/* -------------------------------------------------------------- kinds ---- */

/**
 * Index is the kindIndex baked into the sheet, so **reordering this renames every monster**:
 * a slime would draw bat frames. Checked against MONSTER_SPRITE_ORDER in monsterSprites.ts
 * below, the same discipline import-avatar.mjs applies to AVATAR_SKIN_COUNT.
 */
const KINDS = [
  {
    kind: "slime",
    palette: SLIME_PALETTE,
    bodies: SLIME_BODIES,
    faces: SLIME_FACES,
    faceWidth: SLIME_FACE_WIDTH,
    faceX: SLIME_FACE_X,
    faceY: (step) => SLIME_FACE_Y[step],
  },
  {
    kind: "bat",
    palette: BAT_PALETTE,
    bodies: BAT_BODIES,
    faces: BAT_FACES,
    faceWidth: BAT_FACE_WIDTH,
    faceX: BAT_FACE_X,
    faceY: () => BAT_FACE_Y,
  },
];

function buildMonsterFrame(spec, direction, step) {
  const label = `${spec.kind}/${direction}/${step}`;
  const native = new Canvas(SRC_TILE, SRC_TILE);
  paintRows(native, spec.bodies[step], spec.palette, 0, 0, SRC_TILE, `${label} body`);
  paintRows(
    native,
    spec.faces[direction],
    spec.palette,
    spec.faceX,
    spec.faceY(step),
    spec.faceWidth,
    `${label} face`,
  );
  return upscale(native, SCALE);
}

function buildMonsterSheet() {
  const sheet = new Canvas(
    FRAME_STEPS.length * TILE,
    KINDS.length * DIRECTION_ROWS.length * TILE,
  );
  KINDS.forEach((spec, kindIndex) => {
    DIRECTION_ROWS.forEach((direction, dirIndex) => {
      FRAME_STEPS.forEach((step, col) => {
        const frame = buildMonsterFrame(spec, direction, step);
        sheet.blit(frame, col * TILE, (kindIndex * DIRECTION_ROWS.length + dirIndex) * TILE);
      });
    });
  });
  return sheet;
}

/* -------------------------------------------------------------- items ---- */

const ITEM_PALETTE = {
  ".": null,
  o: hex("#2b2433"),
  g: hex("#58b95c"),
  G: hex("#3d8a45"),
  l: hex("#93dd8e"),
  m: hex("#a695cc"),
  P: hex("#574a78"),
  c: hex("#c9873f"),
  C: hex("#a2662b"),
  y: hex("#efc06a"),
  h: hex("#4e9b52"),
  H: hex("#37743c"),
  s: hex("#6f4b2a"),
  d: hex("#b9bfcb"),
  w: hex("#e6eaf1"),
  k: hex("#6b4a2e"),
  K: hex("#4a331f"),
};

/**
 * Column order of items.png, and therefore the value of `ItemDefinition.icon` the server sends.
 * Checked against ITEM_ICON_ORDER in inventoryPanel.ts below for the same reason KINDS is
 * checked: an icon key with no column draws the bag's fallback slot instead of the item.
 */
const ITEMS = [
  {
    icon: "slime-jelly",
    rows: [
      "................",
      "................",
      "................",
      ".....oooooo.....",
      "...oollllggoo...",
      "..olllggggggo...",
      ".ollgggggggggo..",
      ".olggggggggggo..",
      ".oggggggggggggo.",
      ".oggggggggggggo.",
      ".oggggggggggggo.",
      ".ogggggggggGGGo.",
      ".oGGGGGGGGGGGGo.",
      "..oooooooooooo..",
      "................",
      "................",
    ],
  },
  {
    icon: "bat-wing",
    rows: [
      "................",
      "..oo............",
      "..omo...........",
      "..ommo..........",
      "..ommmo.........",
      "..ommmmoo.......",
      "..ommmmmmo......",
      "..ommmmmmmoo....",
      "..ommmmmmmmmo...",
      "..oPmmmmmmmmmo..",
      "..oPPmmmmmmmmmo.",
      "..oPPPmmmmmmmmo.",
      "..ooPPPmmmmmmoo.",
      "...ooooooooooo..",
      "................",
      "................",
    ],
  },
  {
    icon: "copper-coin",
    rows: [
      "................",
      "................",
      "......oooo......",
      "....oyyyyyyo....",
      "...oyyyycccco...",
      "..oyycccccccco..",
      ".oycccCCCCcccco.",
      ".occccCccCcccco.",
      ".occccCccCcccco.",
      ".occccCCCCcccco.",
      "..occcccccccco..",
      "...oCCCCCCCCo...",
      "....oCCCCCCo....",
      "......oooo......",
      "................",
      "................",
    ],
  },
  {
    icon: "herb",
    rows: [
      "................",
      "................",
      ".......oo.......",
      "......ohho......",
      "..oo..ohho..oo..",
      ".ohho.ohho.ohho.",
      ".ohhho.oo.ohhho.",
      ".oHhho.ss.ohHHo.",
      "..oHHo.ss.oHHo..",
      "...oo..ss..oo...",
      "......osso......",
      "......osso......",
      "......osso......",
      ".......oo.......",
      "................",
      "................",
    ],
  },
  {
    icon: "old-dagger",
    rows: [
      ".......oo.......",
      "......owwo......",
      "......owdo......",
      "......owdo......",
      "......owdo......",
      "......owdo......",
      "......owdo......",
      "......owdo......",
      "....oooooooo....",
      "....oKKKKKKo....",
      "....oooooooo....",
      "......okko......",
      "......okko......",
      "......okko......",
      ".....oKKKKo.....",
      ".....oooooo.....",
    ],
  },
];

function buildItemSheet() {
  const sheet = new Canvas(ITEMS.length * TILE, TILE);
  ITEMS.forEach((item, index) => {
    const native = new Canvas(SRC_TILE, SRC_TILE);
    paintRows(native, item.rows, ITEM_PALETTE, 0, 0, SRC_TILE, `item ${item.icon}`);
    sheet.blit(upscale(native, SCALE), index * TILE, 0);
  });
  return sheet;
}

/* ------------------------------------------------------------ verify ---- */

/**
 * Reads a `const NAME = [...] as const` string array out of a TypeScript source. The client array
 * is the authority — it is what Phaser indexes the sheet with — so this generator conforms to it
 * rather than the other way round, and refuses to bake anything if the two have drifted.
 */
function readOrderArray(file, name) {
  const source = readFileSync(file, "utf8");
  const match = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) throw new Error(`${file}: ${name} not found`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function assertOrderMatches(file, name, mine) {
  const theirs = readOrderArray(file, name);
  if (theirs.length !== mine.length || theirs.some((value, index) => value !== mine[index])) {
    throw new Error(
      `${name} is [${theirs.join(", ")}] but this generator bakes [${mine.join(", ")}]`,
    );
  }
}

function frameDigest(sheet, x, y) {
  const hash = createHash("sha256");
  for (let dy = 0; dy < TILE; dy += 1) {
    hash.update(sheet.data.subarray(sheet.at(x, y + dy), sheet.at(x + TILE, y + dy)));
  }
  return hash.digest("hex");
}

function opaquePixels(sheet, x, y) {
  let count = 0;
  for (let dy = 0; dy < TILE; dy += 1) {
    for (let dx = 0; dx < TILE; dx += 1) {
      if (sheet.data[sheet.at(x + dx, y + dy) + 3] !== 0) count += 1;
    }
  }
  return count;
}

/**
 * The failure this guards against is silent: Phaser draws a frame that is empty, or four facings
 * that are the same picture, without any error — the monster just looks broken or directionless.
 */
function verifyMonsterSheet(sheet) {
  const expectedWidth = FRAME_STEPS.length * TILE;
  const expectedHeight = KINDS.length * DIRECTION_ROWS.length * TILE;
  if (sheet.width !== expectedWidth || sheet.height !== expectedHeight) {
    throw new Error(
      `monster sheet is ${sheet.width}x${sheet.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }

  const report = [];
  KINDS.forEach((spec, kindIndex) => {
    const perDirection = new Map();
    DIRECTION_ROWS.forEach((direction, dirIndex) => {
      const row = kindIndex * DIRECTION_ROWS.length + dirIndex;
      const digests = FRAME_STEPS.map((step, col) => {
        const filled = opaquePixels(sheet, col * TILE, row * TILE);
        if (filled === 0) {
          throw new Error(`${spec.kind}/${direction}/${step} is an empty frame`);
        }
        return frameDigest(sheet, col * TILE, row * TILE);
      });
      // Three identical columns is an animation that never moves, which is as invisible a
      // defect as an empty frame and comes from the same kind of copy-paste.
      if (new Set(digests).size !== FRAME_STEPS.length) {
        throw new Error(`${spec.kind}/${direction}: the three walk columns are not all different`);
      }
      perDirection.set(direction, digests.join(""));
      report.push({
        kind: spec.kind,
        direction,
        row,
        pixels: FRAME_STEPS.map((_step, col) => opaquePixels(sheet, col * TILE, row * TILE)),
      });
    });
    if (new Set(perDirection.values()).size !== DIRECTION_ROWS.length) {
      throw new Error(`${spec.kind}: the four direction rows are not all different`);
    }
  });
  return report;
}

function verifyItemSheet(sheet) {
  const expectedWidth = ITEMS.length * TILE;
  if (sheet.width !== expectedWidth || sheet.height !== TILE) {
    throw new Error(
      `item sheet is ${sheet.width}x${sheet.height}, expected ${expectedWidth}x${TILE}`,
    );
  }
  const digests = ITEMS.map((item, index) => {
    const filled = opaquePixels(sheet, index * TILE, 0);
    if (filled === 0) throw new Error(`item ${item.icon} is an empty frame`);
    return { icon: item.icon, pixels: filled, digest: frameDigest(sheet, index * TILE, 0) };
  });
  if (new Set(digests.map((entry) => entry.digest)).size !== ITEMS.length) {
    throw new Error("two item icons are pixel-identical");
  }
  return digests;
}

/* --------------------------------------------------------------- emit ---- */

function write(relativePath, contents, canvas) {
  const target = resolve(ASSETS_DIR, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  console.log(
    `wrote ${relativePath} (${contents.length} bytes, ${canvas.width}x${canvas.height})`,
  );
  console.log(`  sha256 ${createHash("sha256").update(contents).digest("hex")}`);
}

assertOrderMatches(
  MONSTER_SPRITES_TS,
  "MONSTER_SPRITE_ORDER",
  KINDS.map((spec) => spec.kind),
);
assertOrderMatches(
  INVENTORY_PANEL_TS,
  "ITEM_ICON_ORDER",
  ITEMS.map((item) => item.icon),
);

// Both sheets are built and checked before either one lands: a run that fails halfway must leave
// assets/sprites exactly as it found it, not with a new monster sheet beside stale icons.
const monsters = buildMonsterSheet();
const monsterReport = verifyMonsterSheet(monsters);
const items = buildItemSheet();
const itemReport = verifyItemSheet(items);

write("sprites/monster.png", encodePng(monsters), monsters);
for (const entry of monsterReport) {
  console.log(
    `  ${entry.kind}/${entry.direction} row ${entry.row} — opaque px ${entry.pixels.join("/")}`,
  );
}

write("sprites/items.png", encodePng(items), items);
for (const [index, entry] of itemReport.entries()) {
  console.log(`  frame ${index}: ${entry.icon} — opaque px ${entry.pixels}`);
}
