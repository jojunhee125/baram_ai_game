// Regenerates the Phase1 placeholder art - the tileset and the avatar sheet - under code/assets.
// See code/assets/README.md.
//
// The map is no longer built here: tools/generate-plaza.mjs owns assets/maps/plaza.json. The two
// were tied together only by history, and it made the layout uneditable - a one-tile change meant
// running this script, which reverts the reskinned art at the same time.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The shipped art is reskinned from the Ninja Adventure Pack by tools/import-ninja-assets.mjs,
// so falling back to the placeholders has to be deliberate rather than a stray `node` invocation.
// This script is frozen at its Phase1 shape: SKIN_SHIRTS still holds 8 skins, so a forced run
// emits a 96x1024 avatar sheet while shared AVATAR_SKIN_COUNT (and assets/README.md) says 4 -
// skins 4-7 would ship as frames the runtime never selects.
if (!process.argv.includes("--force-placeholder")) {
  console.error("this script generates the Phase1 placeholder art and would overwrite the reskinned assets");
  console.error("it also emits 8 avatar skins; the runtime only uses the first 4 (shared AVATAR_SKIN_COUNT)");
  console.error("pass --force-placeholder if that is really what you want");
  process.exit(1);
}

const ASSETS_DIR = resolve(fileURLToPath(new URL("../assets", import.meta.url)));
const TILE = 32;

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

/* ------------------------------------------------------------- canvas ---- */

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }

  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || !color) return;
    const at = (y * this.width + x) * 4;
    this.data[at] = color[0];
    this.data[at + 1] = color[1];
    this.data[at + 2] = color[2];
    this.data[at + 3] = color[3];
  }

  rect(x, y, w, h, color) {
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) this.set(x + dx, y + dy, color);
  }

  fill(color) {
    this.rect(0, 0, this.width, this.height, color);
  }

  blit(source, x, y) {
    for (let dy = 0; dy < source.height; dy += 1) {
      for (let dx = 0; dx < source.width; dx += 1) {
        const at = (dy * source.width + dx) * 4;
        if (source.data[at + 3] === 0) continue;
        this.set(x + dx, y + dy, [
          source.data[at],
          source.data[at + 1],
          source.data[at + 2],
          source.data[at + 3],
        ]);
      }
    }
  }
}

function hex(value) {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
    255,
  ];
}

function noise(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ------------------------------------------------------------ tileset ---- */

const C = {
  stone: hex("#c9c2b4"),
  stoneDark: hex("#ada694"),
  stoneLight: hex("#dcd6c9"),
  grout: hex("#9d9684"),
  grass: hex("#7fae5a"),
  grassDark: hex("#6d9a4a"),
  grassLight: hex("#98c471"),
  petalWarm: hex("#f2d06b"),
  petalCool: hex("#e8798a"),
  dirt: hex("#c6a67c"),
  dirtDark: hex("#b2916a"),
  dirtLight: hex("#d8bb95"),
  wood: hex("#b98d5f"),
  woodDark: hex("#9c7449"),
  woodLight: hex("#cea87c"),
  medallion: hex("#b7c3c0"),
  medallionDark: hex("#97a5a3"),
  medallionLight: hex("#d2dbd8"),
  motif: hex("#7f8f8d"),
  sand: hex("#ddd3bb"),
  sandDark: hex("#c8bda3"),
  brick: hex("#b0715a"),
  brickDark: hex("#8e5546"),
  mortar: hex("#d2b39a"),
  block: hex("#8d867a"),
  blockDark: hex("#6f6961"),
  blockLight: hex("#a8a094"),
  pillar: hex("#ded6c6"),
  pillarDark: hex("#b8b0a0"),
  pillarLight: hex("#f0eade"),
  hedge: hex("#4f7c3e"),
  hedgeDark: hex("#3d6330"),
  hedgeLight: hex("#6b9c56"),
  water: hex("#5b93c4"),
  waterDark: hex("#4a7bab"),
  waterLight: hex("#8ec0e2"),
  crate: hex("#b58a58"),
  crateDark: hex("#8d6840"),
  crateFrame: hex("#6f5230"),
  table: hex("#c39c6a"),
  tableDark: hex("#9b7748"),
  tableLeg: hex("#7a5c37"),
  board: hex("#dfc48f"),
  boardDark: hex("#c2a670"),
  post: hex("#8a6238"),
  ink: hex("#7a5c37"),
  outline: hex("#4a4038"),
};

function paintStoneFloor(c, cracked) {
  c.fill(C.stone);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const n = noise(x, y, cracked ? 21 : 11);
      if (x % 16 === 0 || y % 16 === 0) c.set(x, y, C.grout);
      else if (n > 0.93) c.set(x, y, C.stoneLight);
      else if (n < 0.08) c.set(x, y, C.stoneDark);
    }
  }
  if (!cracked) return;
  let x = 6;
  for (let y = 3; y < 29; y += 1) {
    c.set(x, y, C.stoneDark);
    c.set(x + 1, y, C.grout);
    if (noise(x, y, 5) > 0.62) x += 1;
  }
  c.rect(20, 20, 3, 2, C.stoneDark);
  c.rect(23, 9, 2, 2, C.stoneDark);
}

function paintGrass(c, flowers) {
  c.fill(C.grass);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const n = noise(x, y, 31);
      if (n > 0.86) c.rect(x, y, 1, 2, C.grassLight);
      else if (n < 0.14) c.rect(x, y, 1, 2, C.grassDark);
    }
  }
  if (!flowers) return;
  const spots = [
    [5, 7, C.petalWarm],
    [21, 5, C.petalCool],
    [12, 18, C.petalCool],
    [25, 23, C.petalWarm],
    [7, 26, C.petalWarm],
  ];
  for (const [x, y, petal] of spots) {
    c.set(x, y - 1, petal);
    c.set(x - 1, y, petal);
    c.set(x + 1, y, petal);
    c.set(x, y + 1, petal);
    c.set(x, y, C.grassDark);
  }
}

function paintDirt(c) {
  c.fill(C.dirt);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const n = noise(x, y, 41);
      if (n > 0.9) c.rect(x, y, 2, 1, C.dirtLight);
      else if (n < 0.12) c.rect(x, y, 2, 1, C.dirtDark);
    }
  }
}

function paintWood(c) {
  c.fill(C.wood);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      if (noise(x, y, 51) > 0.9) c.rect(x, y, 3, 1, C.woodLight);
    }
  }
  for (let y = 7; y < TILE; y += 8) c.rect(0, y, TILE, 1, C.woodDark);
  c.rect(10, 0, 1, 8, C.woodDark);
  c.rect(24, 8, 1, 8, C.woodDark);
  c.rect(4, 16, 1, 8, C.woodDark);
  c.rect(18, 24, 1, 8, C.woodDark);
}

function paintMedallion(c) {
  c.fill(C.medallion);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const d = Math.abs(x - 15.5) + Math.abs(y - 15.5);
      if (d > 14.5) c.set(x, y, C.medallionDark);
      else if (d > 12.5) c.set(x, y, C.motif);
      else if (d < 3) c.set(x, y, C.medallionLight);
      else if (d > 5 && d < 6.5) c.set(x, y, C.medallionDark);
    }
  }
}

function paintSand(c) {
  c.fill(C.sand);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      if (noise(x, y, 61) > 0.88) c.set(x, y, C.sandDark);
    }
  }
}

function paintBrickWall(c) {
  c.fill(C.mortar);
  for (let row = 0; row < 4; row += 1) {
    const y = row * 8;
    const shift = row % 2 === 0 ? 0 : -8;
    for (let bx = shift; bx < TILE; bx += 16) {
      c.rect(bx + 1, y + 1, 14, 6, C.brick);
      c.rect(bx + 1, y + 6, 14, 1, C.brickDark);
    }
  }
}

function paintStoneBlockWall(c) {
  c.fill(C.blockDark);
  for (let by = 0; by < TILE; by += 16) {
    for (let bx = 0; bx < TILE; bx += 16) {
      c.rect(bx + 1, by + 1, 14, 14, C.block);
      c.rect(bx + 1, by + 1, 14, 1, C.blockLight);
      c.rect(bx + 1, by + 13, 14, 2, C.blockDark);
    }
  }
}

function paintPillar(c) {
  c.rect(6, 0, 20, TILE, C.pillar);
  c.rect(6, 0, 2, TILE, C.pillarDark);
  c.rect(24, 0, 2, TILE, C.pillarDark);
  c.rect(9, 0, 3, TILE, C.pillarLight);
  c.rect(4, 0, 24, 4, C.pillar);
  c.rect(4, 0, 24, 1, C.pillarLight);
  c.rect(4, 3, 24, 1, C.pillarDark);
  c.rect(4, 27, 24, 5, C.pillar);
  c.rect(4, 27, 24, 1, C.pillarLight);
  c.rect(4, 31, 24, 1, C.pillarDark);
}

function paintHedge(c) {
  c.rect(1, 2, 30, 29, C.hedge);
  c.rect(2, 1, 28, 31, C.hedge);
  for (let y = 1; y < TILE; y += 1) {
    for (let x = 1; x < TILE - 1; x += 1) {
      const n = noise(x, y, 71);
      if (n > 0.84) c.set(x, y, C.hedgeLight);
      else if (n < 0.2) c.set(x, y, C.hedgeDark);
    }
  }
  c.rect(2, 1, 28, 2, C.hedgeLight);
  c.rect(2, 29, 28, 3, C.hedgeDark);
}

function paintWater(c) {
  c.fill(C.water);
  for (let y = 0; y < TILE; y += 1) {
    const wave = Math.sin((y / TILE) * Math.PI * 4);
    for (let x = 0; x < TILE; x += 1) {
      if (noise(x, y, 81) > 0.9) c.set(x, y, C.waterDark);
    }
    if (wave > 0.85) c.rect(4 + Math.round(wave * 3), y, 10, 1, C.waterLight);
    if (wave < -0.85) c.rect(18 + Math.round(wave * 3), y, 8, 1, C.waterLight);
  }
}

function paintCrate(c) {
  c.rect(2, 4, 28, 26, C.crateFrame);
  c.rect(4, 6, 24, 22, C.crate);
  for (let i = 0; i < 22; i += 1) {
    c.set(4 + i, 6 + i, C.crateDark);
    c.set(27 - i, 6 + i, C.crateDark);
  }
  c.rect(4, 6, 24, 2, C.crateDark);
  c.rect(4, 26, 24, 2, C.crateDark);
}

function paintTable(c) {
  c.rect(3, 8, 26, 10, C.table);
  c.rect(3, 8, 26, 2, C.woodLight);
  c.rect(3, 16, 26, 2, C.tableDark);
  c.rect(6, 18, 4, 11, C.tableLeg);
  c.rect(22, 18, 4, 11, C.tableLeg);
  c.rect(6, 28, 4, 2, C.outline);
  c.rect(22, 28, 4, 2, C.outline);
}

function paintSign(c) {
  c.rect(14, 16, 4, 15, C.post);
  c.rect(14, 16, 1, 15, C.ink);
  c.rect(4, 3, 24, 16, C.ink);
  c.rect(5, 4, 22, 14, C.board);
  c.rect(5, 15, 22, 3, C.boardDark);
  c.rect(9, 8, 14, 2, C.ink);
  c.rect(9, 12, 10, 2, C.ink);
}

const TILE_PAINTERS = [
  (c) => paintStoneFloor(c, false),
  (c) => paintStoneFloor(c, true),
  (c) => paintGrass(c, false),
  paintWood,
  paintDirt,
  paintMedallion,
  paintSand,
  (c) => paintGrass(c, true),
  paintBrickWall,
  paintStoneBlockWall,
  paintPillar,
  paintHedge,
  paintWater,
  paintCrate,
  paintTable,
  paintSign,
];

const TILESET_COLUMNS = 8;

function buildTileset() {
  const rows = TILE_PAINTERS.length / TILESET_COLUMNS;
  const sheet = new Canvas(TILESET_COLUMNS * TILE, rows * TILE);
  TILE_PAINTERS.forEach((paint, id) => {
    const cell = new Canvas(TILE, TILE);
    paint(cell);
    sheet.blit(cell, (id % TILESET_COLUMNS) * TILE, Math.floor(id / TILESET_COLUMNS) * TILE);
  });
  return sheet;
}

/* ------------------------------------------------------------- avatar ---- */

const SKIN_SHIRTS = [
  ["#d8695f", "#b4514a"],
  ["#d99248", "#b57436"],
  ["#c2b04a", "#9e8e37"],
  ["#6aab5c", "#528a46"],
  ["#45a79c", "#348781"],
  ["#5387c2", "#4069a0"],
  ["#8570bd", "#6a579c"],
  ["#c46e9c", "#a1567e"],
];

const BASE_PALETTE = {
  ".": null,
  o: hex("#3a3038"),
  k: hex("#5b4436"),
  h: hex("#75594a"),
  s: hex("#f4cda6"),
  d: hex("#dba97f"),
  e: hex("#3a3038"),
  m: hex("#b5745a"),
  r: hex("#f0a394"),
  p: hex("#55607a"),
  P: hex("#444d63"),
  b: hex("#4a4038"),
};

const ART_WIDTH = 16;
const ART_HEIGHT = 24;
const ART_OFFSET_X = 8;
const ART_OFFSET_Y = 6;

const HEAD_DOWN = [
  "....oooooooo....",
  "..ookkkkkkkkoo..",
  ".okkkkkkkkkkkko.",
  ".okkhhhhhhhhkko.",
  ".okkkkkkkkkkkko.",
  ".okssssssssssko.",
  ".okseesssseesko.",
  ".okssssssssssko.",
  ".oksrssmmssrsko.",
  ".okssssssssssko.",
  "..osssssssssso..",
  "...oooooooooo...",
];

const HEAD_LEFT = [
  "....oooooooo....",
  "..ookkkkkkkkoo..",
  ".okkkkkkkkkkkko.",
  ".okkhhhhhhkkkko.",
  ".okkkkkkkkkkkko.",
  ".osssssssskkkko.",
  ".oseessssskkkko.",
  ".osssssssskkkko.",
  ".osmsrsssskkkko.",
  ".osssssssskkkko.",
  "..osssssssskko..",
  "...oooooooooo...",
];

const HEAD_UP = [
  "....oooooooo....",
  "..ookkkkkkkkoo..",
  ".okkkkkkkkkkkko.",
  ".okkkkkkkkkkkko.",
  ".okkhhhhhhhhkko.",
  ".okkkkkkkkkkkko.",
  ".okkkkkkkkkkkko.",
  ".okkkkkkkkkkkko.",
  ".okkkkkkkkkkkko.",
  ".okkkkkkkkkkkko.",
  "..okkkkkkkkkko..",
  "...oooooooooo...",
];

const BODY_FRONT = [
  "..occccccccCCo..",
  "..occccccccCCo..",
  "..osccccccCCso..",
  "..osccccccCCso..",
  "..osccccccCCso..",
  "..osccccccCCso..",
  "..osppppppPPso..",
  "..ooppppppPPoo..",
];

const BODY_LEFT = [
  "...occcccccco...",
  "...occcccccco...",
  "...osccccccCo...",
  "...osccccccCo...",
  "...osccccccCo...",
  "...osccccccCo...",
  "...ospppppPPo...",
  "...oppppppPPo...",
];

const LEGS_FRONT = {
  idle: ["...opppooPPPo...", "...opppooPPPo...", "...obbboobbbo...", "...oooooooooo..."],
  stepA: ["...opppooPPPo...", "...opppoobbbo...", "...obbbooooo....", "...oooooo......."],
  stepB: ["...opppooPPPo...", "...obbbooPPPo...", "....ooooobbbo...", ".......oooooo..."],
};

const LEGS_LEFT = {
  idle: ["....opppppPo....", "....opppppPo....", "....obbbbbbo....", "....oooooooo...."],
  stepA: ["....opppppPo....", "...oppppoPPo....", "...obbboobbo....", "...ooooooooo...."],
  stepB: ["....opppppPo....", "....opppoPPo....", "....obboobbbo...", "....ooooooooo..."],
};

function mirror(rows) {
  return rows.map((row) => [...row].reverse().join(""));
}

function poseRows(direction, step) {
  if (direction === "left" || direction === "right") {
    const rows = [...HEAD_LEFT, ...BODY_LEFT, ...LEGS_LEFT[step]];
    return direction === "left" ? rows : mirror(rows);
  }
  const head = direction === "up" ? HEAD_UP : HEAD_DOWN;
  return [...head, ...BODY_FRONT, ...LEGS_FRONT[step]];
}

function assertPose(rows, label) {
  if (rows.length !== ART_HEIGHT) throw new Error(`${label}: expected ${ART_HEIGHT} rows, got ${rows.length}`);
  rows.forEach((row, index) => {
    if (row.length !== ART_WIDTH) {
      throw new Error(`${label} row ${index}: expected ${ART_WIDTH} chars, got ${row.length} ("${row}")`);
    }
    for (const ch of row) {
      if (ch !== "c" && ch !== "C" && !(ch in BASE_PALETTE)) {
        throw new Error(`${label} row ${index}: unknown palette char "${ch}"`);
      }
    }
  });
}

/** Row order inside one skin block; the index matches the shared Direction enum. */
const DIRECTION_ROWS = ["down", "left", "right", "up"];
const FRAME_STEPS = ["stepA", "idle", "stepB"];

function buildAvatarSheet() {
  const sheet = new Canvas(FRAME_STEPS.length * TILE, SKIN_SHIRTS.length * DIRECTION_ROWS.length * TILE);
  SKIN_SHIRTS.forEach(([shirt, shirtShadow], skin) => {
    const palette = { ...BASE_PALETTE, c: hex(shirt), C: hex(shirtShadow) };
    DIRECTION_ROWS.forEach((direction, dirIndex) => {
      FRAME_STEPS.forEach((step, col) => {
        const rows = poseRows(direction, step);
        assertPose(rows, `${direction}/${step}`);
        const frame = new Canvas(TILE, TILE);
        rows.forEach((row, y) => {
          [...row].forEach((ch, x) => {
            frame.set(ART_OFFSET_X + x, ART_OFFSET_Y + y, palette[ch]);
          });
        });
        sheet.blit(frame, col * TILE, (skin * DIRECTION_ROWS.length + dirIndex) * TILE);
      });
    });
  });
  return sheet;
}

/* --------------------------------------------------------------- emit ---- */

function write(relativePath, contents) {
  const target = resolve(ASSETS_DIR, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  console.log(`wrote ${relativePath} (${contents.length} bytes)`);
}

const tileset = buildTileset();
write("tilesets/plaza-tiles.png", encodePng(tileset));

const avatar = buildAvatarSheet();
write("sprites/avatar.png", encodePng(avatar));
