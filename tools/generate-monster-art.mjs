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

/* ----------------------------------------------------------- squirrel ---- */

const SQUIRREL_PALETTE = {
  ".": null,
  o: hex("#2b1810"),
  t: hex("#c97c3f"),
  T: hex("#9c5a2c"),
  c: hex("#f6e2b8"),
  e: hex("#1c1008"),
};

/**
 * Crouch / stand / hop. Ground-type, unlike the bird's-eye bat this replaces: every pose sits
 * flush on the cell floor (row 15 is always opaque), and the big curled tail is what draws the
 * eye upward instead. `idle` carries the tail fully curled over the back; `stepA` droops it low
 * as the body crouches, `stepB` flares it higher as the hop stretches the body upward — the same
 * squash/neutral/stretch rhythm the torso underneath still uses, recolored from this file's
 * previous slime.
 */
const SQUIRREL_BODIES = {
  stepA: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "..oo.oo..ottttto",
    "..tt.tt..ottttto",
    "....oooooooo....",
    "..occcttttttto..",
    ".occtttttttttto.",
    "octtttttttttttto",
    "otttttttttttttto",
    "otttttttttttttto",
    "oTTTTTTTTTTTTTTo",
    "oooooooooooooooo",
  ],
  idle: [
    "...........oto..",
    "..........ottto.",
    "..oo.oo..ottttto",
    "..tt.tt..ottttto",
    "..ottttto.otttto",
    "..ottttto.otttto",
    ".....oooooo.....",
    "...ooccccttoo...",
    "..occcttttttto..",
    ".occtttttttttto.",
    ".octtttttttttto.",
    "octtttttttttttto",
    "otttttttttttttto",
    "ottttttttttTTTTo",
    "oTTTTTTTTTTTTTTo",
    ".oooooooooooooo.",
  ],
  stepB: [
    "......otttto....",
    "..oo..otttttto..",
    "..tt..otttttto..",
    "......oooo......",
    "....ooccttoo....",
    "...occcttttto...",
    "...occtttttto...",
    "..occtttttttto..",
    "..octtttttttto..",
    "..otttttttttto..",
    ".otttttttttttto.",
    ".otttttttttttto.",
    ".otttttttttttto.",
    ".otttttttttTTTo.",
    ".oTTTTTTTTTTTTo.",
    "..oooooooooooo..",
  ],
};

const SQUIRREL_FACE_WIDTH = 6;
const SQUIRREL_FACE_X = 5;
/**
 * Rows 9-12 are fur in all three poses regardless of how the ears/tail/torso above them move
 * (checked by eye against every SQUIRREL_BODIES row above), so unlike the bat this face needs no
 * per-pose offset — one fixed band works for the whole walk cycle.
 */
const SQUIRREL_FACE_Y = () => 9;

const SQUIRREL_FACE_LEFT = ["e.....", "e.....", "......", "oo...."];

/**
 * Up is the only facing with no eyes at all: a squirrel turned away is a bare patch of fur with
 * two shaded dimples, which is what makes the four rows of a kind visibly different rather than
 * four copies with the highlight nudged (the check at the bottom of this file refuses the latter).
 */
const SQUIRREL_FACES = {
  down: [".e..e.", ".e..e.", "......", "..oo.."],
  left: SQUIRREL_FACE_LEFT,
  right: mirror(SQUIRREL_FACE_LEFT),
  up: ["......", ".T..T.", "..TT..", "......"],
};

/* ------------------------------------------------------------- rabbit ---- */

const RABBIT_PALETTE = {
  ".": null,
  o: hex("#2e2422"),
  w: hex("#f5f0e6"),
  d: hex("#cfc7ba"),
  p: hex("#e8a6b8"),
  e: hex("#1c1008"),
};

/**
 * Crouch / stand / hop, ground-type like the squirrel above (row 15 is always opaque). The long
 * straight ears are the silhouette's whole job here, in deliberate contrast to the squirrel's
 * small round ones: `stepA` leans them back over the crouch, `idle` holds them fully erect, and
 * `stepB` flares them at the hop's peak. The tail is the opposite trade — just a two-pixel round
 * nub tucked into the torso's back corner, "just a little" rather than the squirrel's dominant
 * curl.
 */
const RABBIT_BODIES = {
  stepA: [
    "................",
    "................",
    "................",
    "....oo...oo.....",
    "....ww...ww.....",
    ".....wp..wp.....",
    ".....wp..wp.....",
    "....ww...ww.....",
    "....oooooooo....",
    "..owwwwwwwwwwo.o",
    ".owwwwwwwwwwwwod",
    "owwwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwwo",
    "oddddddddddddddo",
    "oooooooooooooooo",
  ],
  idle: [
    "....oo...oo.....",
    "....ww...ww.....",
    "....wp...wp.....",
    "....wp...wp.....",
    "....wp...wp.....",
    "....ww...ww.....",
    ".....oooooo.....",
    "...oowwwwwwoo...",
    "..owwwwwwwwwwo.o",
    ".owwwwwwwwwwwwod",
    ".owwwwwwwwwwwwo.",
    "owwwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwwo",
    "owwwwwwwwwwddddo",
    "oddddddddddddddo",
    ".oooooooooooooo.",
  ],
  stepB: [
    "...oo.....oo....",
    "....ww...ww.....",
    "....wp...wp.....",
    "......oooo......",
    "....oowwwwoo....",
    "...owwwwwwwwo...",
    "...owwwwwwwwo...",
    "..owwwwwwwwwwo..",
    "..owwwwwwwwwwo.o",
    "..owwwwwwwwwwo.d",
    ".owwwwwwwwwwwwo.",
    ".owwwwwwwwwwwwo.",
    ".owwwwwwwwwwwwo.",
    ".owwwwwwwwwdddo.",
    ".oddddddddddddo.",
    "..oooooooooooo..",
  ],
};

const RABBIT_FACE_WIDTH = 6;
const RABBIT_FACE_X = 4;
/** Same reasoning as SQUIRREL_FACE_Y: rows 9-12 are fur in all three poses here too. */
const RABBIT_FACE_Y = () => 9;

const RABBIT_FACE_LEFT = ["e.....", "e.....", "......", "oo...."];

/** Up has no eyes, same convention as the squirrel's — a rabbit turned away shows ears, not a face. */
const RABBIT_FACES = {
  down: [".e..e.", ".e..e.", "......", "..oo.."],
  left: RABBIT_FACE_LEFT,
  right: mirror(RABBIT_FACE_LEFT),
  up: ["......", ".d..d.", "..dd..", "......"],
};

/* --------------------------------------------------------------- deer ---- */

const DEER_PALETTE = {
  ".": null,
  o: hex("#241a14"),
  t: hex("#8a5a34"),
  T: hex("#5f3d22"),
  c: hex("#ddc99e"),
  a: hex("#4a3626"),
  e: hex("#1c1008"),
};

/**
 * Graze / stand / hop, ground-type like the other two (a floor line is present in every pose).
 * The forked antlers are the silhouette's whole job here — the dominant top feature, unlike the
 * squirrel's small round ears or the rabbit's long straight ones — and the torso is taller and
 * narrower than either (max fill width 10-12px against the rabbit's full-width 14-16px). `idle`
 * holds the antlers fully erect and the body at its tallest; `stepA` lays the antlers back and
 * drops the whole silhouette down (a flush, full-width floor line, i.e. a crouch/graze); `stepB`
 * flares the antlers wider and stretches the body narrower and taller at the hop's peak, with the
 * narrowest floor line of the three (most lifted off the ground).
 */
const DEER_BODIES = {
  stepA: [
    "................",
    "................",
    "..a.a......a.a..",
    "...a........a...",
    "..oo........oo..",
    "....oooooooo....",
    "....otttttto....",
    "...otttttttto...",
    "..otttttttttto..",
    "..otttttttttto..",
    "..otttttttttto..",
    "..otttttttttto..",
    "..otttttttttto..",
    "..otccccccccto..",
    "oTTTTTTTTTTTTTTo",
    "oooooooooooooooo",
  ],
  idle: [
    "..a.a......a.a..",
    "...a........a...",
    "..oo........oo..",
    "....oooooooo....",
    "....otttttto....",
    "....otttttto....",
    "...otttttttto...",
    "...otttttttto...",
    "..otttttttttto..",
    "..otttttttttto..",
    "..otttttttttto..",
    "..otttttttttto..",
    "..otttttttttto..",
    "..otccccccccto..",
    "oTTTTTTTTTTTTTTo",
    ".oooooooooooooo.",
  ],
  stepB: [
    ".a.a........a.a.",
    "..a..........a..",
    "..oo........oo..",
    ".....oooooo.....",
    ".....otttto.....",
    ".....otttto.....",
    "....otttttto....",
    "...otttttttto...",
    "...otttttttto...",
    "...otttttttto...",
    "...otttttttto...",
    "...otttttttto...",
    "...otttttttto...",
    "...otccccccto...",
    "..oTTTTTTTTTTo..",
    "...oooooooooo...",
  ],
};

const DEER_FACE_WIDTH = 6;
const DEER_FACE_X = 5;
/** Same reasoning as SQUIRREL_FACE_Y: rows 9-12 are fur in all three poses here too. */
const DEER_FACE_Y = () => 9;

const DEER_FACE_LEFT = ["e.....", "e.....", "......", "oo...."];

/**
 * Up has no eyes, same convention as the other two kinds — but shows the antler bases instead of
 * an ear-back shade, since the antlers (not ears) are this kind's silhouette feature.
 */
const DEER_FACES = {
  down: [".e..e.", ".e..e.", "......", "..oo.."],
  left: DEER_FACE_LEFT,
  right: mirror(DEER_FACE_LEFT),
  up: ["......", ".a..a.", "..aa..", "......"],
};

/* -------------------------------------------------------------- kinds ---- */

/**
 * Index is the kindIndex baked into the sheet, so **reordering this renames every monster**:
 * a squirrel would draw rabbit frames. Checked against MONSTER_SPRITE_ORDER in monsterSprites.ts
 * below, the same discipline import-avatar.mjs applies to AVATAR_SKIN_COUNT.
 */
const KINDS = [
  {
    kind: "squirrel",
    palette: SQUIRREL_PALETTE,
    bodies: SQUIRREL_BODIES,
    faces: SQUIRREL_FACES,
    faceWidth: SQUIRREL_FACE_WIDTH,
    faceX: SQUIRREL_FACE_X,
    faceY: SQUIRREL_FACE_Y,
  },
  {
    kind: "rabbit",
    palette: RABBIT_PALETTE,
    bodies: RABBIT_BODIES,
    faces: RABBIT_FACES,
    faceWidth: RABBIT_FACE_WIDTH,
    faceX: RABBIT_FACE_X,
    faceY: RABBIT_FACE_Y,
  },
  {
    kind: "deer",
    palette: DEER_PALETTE,
    bodies: DEER_BODIES,
    faces: DEER_FACES,
    faceWidth: DEER_FACE_WIDTH,
    faceX: DEER_FACE_X,
    faceY: DEER_FACE_Y,
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
  /** Carrot's root — repurposed from the two colours slime-jelly's green fill used to own. */
  g: hex("#e8821f"),
  G: hex("#b5620f"),
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
    icon: "acorn",
    rows: [
      "................",
      ".......oo.......",
      ".....oooooo.....",
      "....okkkkkko....",
      "...okkkkkkkko...",
      "...oKKKKKKKKo...",
      "....oyyyyyyo....",
      "...oyyyyyyyyo...",
      "...oyyyccyyyo...",
      "...oyyyccyyyo...",
      "....occcccco....",
      ".....occcco.....",
      "......occo......",
      ".......oo.......",
      "................",
      "................",
    ],
  },
  {
    icon: "carrot",
    rows: [
      "......H..H......",
      ".....hh..hh.....",
      "......hHHh......",
      ".....oooooo.....",
      "....oggGGggo....",
      "...ogggGGgggo...",
      "...ogggGGgggo...",
      "....oggggggo....",
      ".....oggggo.....",
      ".....oGGGGo.....",
      "......oGGo......",
      "......oggo......",
      ".......oo.......",
      "................",
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
