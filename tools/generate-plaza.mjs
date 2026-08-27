// Builds the plaza map - the room every session starts in - into assets/maps/plaza.json.
//
//   node tools/generate-plaza.mjs        (cwd = code/)
//
// Split out of tools/generate-assets.mjs, where this layout used to live: that script emits the
// Phase1 placeholder art, so editing one tile of plaza meant a run that also reverted
// tilesets/plaza-tiles.png and sprites/avatar.png to their pre-reskin versions. This script
// writes the map and nothing else.
//
// The walkable interior is hand-authored ASCII art (GROUND_ROWS / COLLISION_ROWS) so a layout
// change stays a reviewable diff. The border band around it is procedural: it is scenery nobody
// can ever stand on and it outnumbers the interior nearly three to one, so drawing it by hand
// would bury the part that matters. Nothing is random - every cell is a pure function of its
// coordinates - so the same source always produces the same bytes.
//
// No art is authored here either: the tileset block is copied verbatim out of the previous
// plaza.json, so a reskin of plaza-tiles.png carries over without this script being touched.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VIEWPORT_HEIGHT_TILES, VIEWPORT_WIDTH_TILES, cameraBorderTiles } from "../shared/src/camera.ts";
import { VIEW_RADIUS_TILES } from "../shared/src/constants.ts";

const CODE_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** Read for its tileset block, then overwritten with the layout below. */
const MAP_FILE = "assets/maps/plaza.json";

function fail(message) {
  console.error(`generate-plaza: ${message}`);
  process.exit(1);
}

/**
 * Non-walkable margin, in tiles, that keeps the Phaser camera off its own `setBounds` clamp.
 * While no walkable tile lies inside it the local player stays exactly screen-centred, which is
 * the invariant VIEW_RADIUS_TILES is derived from (shared/src/camera.ts).
 */
const BORDER = cameraBorderTiles(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES);

/**
 * Longest straight walkable run the map has to contain. The integration suite separates two
 * players by VIEW_RADIUS_TILES + 1 along one row to exercise view filtering, which needs
 * VIEW_RADIUS_TILES + 2 tiles end to end.
 */
const MIN_OPEN_RUN = VIEW_RADIUS_TILES + 2;

/* --------------------------------------------------------------- tiles ---- */

/** Tile ids in plaza-tiles.png: 0-7 walkable, 8-15 `collides: true` (assets/README.md). */
const TILE = {
  stoneFloor: 0,
  stoneCracked: 1,
  grass: 2,
  woodDeck: 3,
  dirtPath: 4,
  medallion: 5,
  sand: 6,
  flowerGrass: 7,
  brickWall: 8,
  brickCorner: 9,
  treeStump: 10,
  bush: 11,
  water: 12,
  crate: 13,
  pot: 14,
  mossyRock: 15,
};

const GROUND_LEGEND = {
  ".": TILE.stoneFloor,
  ",": TILE.stoneCracked,
  g: TILE.grass,
  w: TILE.woodDeck,
  d: TILE.dirtPath,
  m: TILE.medallion,
  f: TILE.flowerGrass,
};

const COLLISION_LEGEND = {
  W: TILE.brickWall,
  P: TILE.treeStump,
  H: TILE.bush,
  "~": TILE.water,
  C: TILE.crate,
  T: TILE.pot,
  N: TILE.mossyRock,
};

/** In COLLISION_ROWS only: no tile at all (gid 0), i.e. a walkable cell. */
const BLANK = ".";

/* ------------------------------------------------------------ interior ---- */

/**
 * The walkable area, exactly one screenful (VIEWPORT_WIDTH_TILES x VIEWPORT_HEIGHT_TILES).
 * Same plaza the 20x15 map drew - fountain at the centre, dirt boulevards crossing under it,
 * four lawns in the quadrants, clutter in the corners - re-laid at the new size:
 *
 *   rows 0 / 5-6 / 11-12 / 17   paved promenades, deliberately free of props: rows 6, 11 and 12
 *                               are the open corridors the integration suite walks (MIN_OPEN_RUN)
 *   rows 1-4 / 13-16            lawns, where every prop lives
 *   rows 7-10                   the plaza band: dirt arms, medallion floor, 4x4 fountain
 *   cols 14-17                  the north-south boulevard; the south door opens off its foot
 *
 * The two blocks are read together cell by cell, so a row that drifts out of alignment with the
 * other block moves a prop off its lawn rather than failing - hence the checks further down.
 */
const GROUND_ROWS = [
  "..............dddd..............",
  ".gfgggggfg....dddd....gfgggggfg.",
  ".ggggfgggg....dddd....ggggfgggg.",
  ".gggggggfg....dddd....gfggggggg.",
  ".ggfgggggg....dddd....ggggggfgg.",
  "............mmmmmmmm............",
  "..........,.mmmmmmmm.,..........",
  "ddddddddddddmmmmmmmmdddddddddddd",
  "ddddddddddddmmmmmmmmdddddddddddd",
  "ddddddddddddmmmmmmmmdddddddddddd",
  "ddddddddddddmmmmmmmmdddddddddddd",
  "..........,.mmmmmmmm.,..........",
  "............mmmmmmmm............",
  ".ggfgggggg....dddd....ggggggfgg.",
  ".gggggggfg....dddd....gfggggggg.",
  ".ggggfgggg....dddd....ggggfgggg.",
  ".gfgggggfg....dddd....gfgggggfg.",
  "..............dwwd..............",
];

const COLLISION_ROWS = [
  "................................",
  ".H...N...H............H...N...H.",
  "................................",
  "...P...P................P...P...",
  "................................",
  "................................",
  "................................",
  "..............~~~~..............",
  "..............~~~~..............",
  "..............~~~~..............",
  "..............~~~~..............",
  "................................",
  "................................",
  "................................",
  "...P...P................P...P...",
  "..CC......................T.....",
  ".H.......H............H.......H.",
  "................................",
];

/* ------------------------------------------------------------ scenery ---- */

/**
 * Fraction of the way out through the band at which each scenery layer ends, so that every side
 * shows the same sequence even though the band is 16 tiles deep left and right but only 8 above
 * and 9 below. Reading outwards: the plaza wall, the town behind it, gardens, forest, a sandy
 * shore and finally open water.
 */
const BAND = { town: 0.4, garden: 0.65, forest: 0.82, shore: 0.9 };

/** Houses this long along the band, separated by alleys filling the rest of the period. */
const TOWN_PERIOD = 7;
const TOWN_HOUSE = 5;

/**
 * A value hash of one cell, used to break up the natural bands into something that does not read
 * as stripes. Pure integer arithmetic on the coordinates - no RNG state anywhere - so the map
 * stays byte-identical between runs and machines.
 */
function scatter(x, y, salt) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Masonry, with a market stall against the front wall so the run of brick is never unbroken. */
function townCell(along, depth) {
  const offset = along % TOWN_PERIOD;
  if (offset < TOWN_HOUSE) {
    if (depth === 2 && offset === 2) {
      return { ground: TILE.stoneFloor, collision: TILE.crate };
    }
    return { ground: TILE.stoneFloor, collision: TILE.brickWall };
  }
  const clutter = [TILE.crate, TILE.pot, TILE.mossyRock][(offset + depth) % 3];
  return { ground: TILE.stoneCracked, collision: clutter };
}

function gardenCell(x, y) {
  const roll = scatter(x, y, 1) % 8;
  return {
    ground: roll === 0 ? TILE.flowerGrass : TILE.grass,
    collision: roll === 1 ? TILE.mossyRock : TILE.bush,
  };
}

function forestCell(x, y) {
  const roll = scatter(x, y, 2) % 5;
  return {
    ground: roll === 4 ? TILE.dirtPath : TILE.grass,
    collision: roll < 3 ? TILE.treeStump : TILE.bush,
  };
}

function shoreCell(x, y) {
  const roll = scatter(x, y, 3) % 4;
  return { ground: TILE.sand, collision: roll === 0 ? TILE.mossyRock : TILE.bush };
}

/* ---------------------------------------------------------- geometry ---- */

/** `blank`, where a block has one, is the character that stands for no tile at all. */
function toTileIds(rows, legend, label, blank) {
  const [first] = rows;
  if (first === undefined) {
    fail(`${label}: no rows`);
  }
  const width = first.length;
  const grid = [];
  rows.forEach((row, y) => {
    if (row.length !== width) {
      fail(`${label} row ${y}: ${row.length} chars, expected ${width} ("${row}")`);
    }
    for (const character of row) {
      if (character === blank) {
        grid.push(null);
        continue;
      }
      const id = legend[character];
      if (id === undefined) {
        fail(`${label} row ${y}: unknown legend character ${JSON.stringify(character)}`);
      }
      grid.push(id);
    }
  });
  return { width, height: rows.length, grid };
}

const interiorGround = toTileIds(GROUND_ROWS, GROUND_LEGEND, "GROUND_ROWS");
const interiorCollision = toTileIds(COLLISION_ROWS, COLLISION_LEGEND, "COLLISION_ROWS", BLANK);

if (
  interiorGround.width !== interiorCollision.width ||
  interiorGround.height !== interiorCollision.height
) {
  fail(
    `GROUND_ROWS is ${interiorGround.width}x${interiorGround.height} but COLLISION_ROWS is ` +
      `${interiorCollision.width}x${interiorCollision.height}; the two blocks are read cell by cell`,
  );
}
if (
  interiorGround.width !== VIEWPORT_WIDTH_TILES ||
  interiorGround.height !== VIEWPORT_HEIGHT_TILES
) {
  fail(
    `the walkable area is ${interiorGround.width}x${interiorGround.height}, but the viewport is now ` +
      `${VIEWPORT_WIDTH_TILES}x${VIEWPORT_HEIGHT_TILES}; re-author GROUND_ROWS/COLLISION_ROWS to match`,
  );
}

const INTERIOR = { width: interiorGround.width, height: interiorGround.height };
const MAP = {
  width: BORDER.left + INTERIOR.width + BORDER.right,
  height: BORDER.top + INTERIOR.height + BORDER.bottom,
};

/**
 * Recorded here because the layout is built around them: the room spawn sits on the open
 * promenade row south of the fountain, and the south door opens off the foot of the boulevard
 * directly below it. The authoritative copies live in server/src/rooms/definitions.ts and
 * portalDefinitions.ts - the checks below only prove this map can carry them.
 */
const SPAWN = { tileX: 31, tileY: 20 };
const PORTAL = {
  triggers: [
    { tileX: 31, tileY: 25 },
    { tileX: 32, tileY: 25 },
  ],
  arrival: { tileX: 31, tileY: 24 },
};

/** `collision: null` means an empty cell (gid 0), i.e. walkable. */
function cellAt(x, y) {
  const localX = x - BORDER.left;
  const localY = y - BORDER.top;
  if (localX >= 0 && localX < INTERIOR.width && localY >= 0 && localY < INTERIOR.height) {
    const index = localY * INTERIOR.width + localX;
    return { ground: interiorGround.grid[index], collision: interiorCollision.grid[index] };
  }

  const interiorRight = BORDER.left + INTERIOR.width;
  const interiorBottom = BORDER.top + INTERIOR.height;
  const outX = x < BORDER.left ? BORDER.left - x : x >= interiorRight ? x - interiorRight + 1 : 0;
  const outY = y < BORDER.top ? BORDER.top - y : y >= interiorBottom ? y - interiorBottom + 1 : 0;

  // The ring one tile out from the interior is the plaza's own wall, corners included - the
  // silhouette the 20x15 map drew by hand.
  if (Math.max(outX, outY) === 1) {
    return {
      ground: TILE.stoneFloor,
      collision: outX === 1 && outY === 1 ? TILE.brickCorner : TILE.brickWall,
    };
  }

  const depthX = outX / (x < BORDER.left ? BORDER.left : BORDER.right);
  const depthY = outY / (y < BORDER.top ? BORDER.top : BORDER.bottom);
  // Mitred like a picture frame: whichever axis is further along its own band picks the layer and
  // the direction the pattern runs in, so the four sides meet along the diagonals.
  const horizontal = depthX >= depthY;
  const depth = Math.max(depthX, depthY);
  if (depth <= BAND.town) return townCell(horizontal ? y : x, horizontal ? outX : outY);
  if (depth <= BAND.garden) return gardenCell(x, y);
  if (depth <= BAND.forest) return forestCell(x, y);
  if (depth <= BAND.shore) return shoreCell(x, y);
  return { ground: TILE.sand, collision: TILE.water };
}

/* ----------------------------------------------------------- template ---- */

function readTileset() {
  const path = resolve(CODE_DIR, MAP_FILE);
  let template;
  try {
    template = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(
      `cannot read the format template ${MAP_FILE} at ${path}: ${cause.message}\n` +
        "  the tileset block is authored by tools/import-ninja-assets.mjs, not by this script;\n" +
        "  restore the file from git before regenerating the layout",
    );
  }
  if (!Array.isArray(template.tilesets) || template.tilesets.length !== 1) {
    fail(`${MAP_FILE} must embed exactly one tileset to copy`);
  }
  const [tileset] = template.tilesets;
  if (!Number.isInteger(tileset.firstgid) || tileset.firstgid <= 0) {
    fail(`${MAP_FILE} tileset firstgid is ${String(tileset.firstgid)}, expected a positive integer`);
  }
  if (!Number.isInteger(tileset.tilecount) || tileset.tilecount <= 0) {
    fail(`${MAP_FILE} tileset tilecount is ${String(tileset.tilecount)}, expected a positive integer`);
  }
  const blockedTileIds = new Set(
    (tileset.tiles ?? [])
      .filter((tile) => (tile.properties ?? []).some((p) => p.name === "collides" && p.value === true))
      .map((tile) => tile.id),
  );
  for (const [name, id] of Object.entries(TILE)) {
    if (id < 0 || id >= tileset.tilecount) {
      fail(`${MAP_FILE} tileset holds ${tileset.tilecount} tiles, but this script uses ${name} = id ${id}`);
    }
  }
  return { template, tileset, blockedTileIds };
}

/* -------------------------------------------------------------- build ---- */

function buildLayers(firstgid) {
  const cellCount = MAP.width * MAP.height;
  const ground = new Array(cellCount);
  const collision = new Array(cellCount);
  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      const index = y * MAP.width + x;
      const cell = cellAt(x, y);
      ground[index] = firstgid + cell.ground;
      collision[index] = cell.collision === null ? 0 : firstgid + cell.collision;
    }
  }
  return { ground, collision };
}

function tileLayer(name, id, data) {
  return {
    data,
    height: MAP.height,
    id,
    name,
    opacity: 1,
    type: "tilelayer",
    visible: true,
    width: MAP.width,
    x: 0,
    y: 0,
  };
}

/* --------------------------------------------------------- self-check ---- */

function isInBorder(x, y) {
  return (
    x < BORDER.left ||
    x >= BORDER.left + INTERIOR.width ||
    y < BORDER.top ||
    y >= BORDER.top + INTERIOR.height
  );
}

function floodFill(walkable, startIndex) {
  const seen = new Uint8Array(walkable.length);
  const stack = new Int32Array(walkable.length);
  let top = 0;
  stack[top++] = startIndex;
  seen[startIndex] = 1;
  let reached = 0;
  while (top > 0) {
    const index = stack[--top];
    reached += 1;
    const x = index % MAP.width;
    const y = (index - x) / MAP.width;
    if (x > 0) push(index - 1);
    if (x < MAP.width - 1) push(index + 1);
    if (y > 0) push(index - MAP.width);
    if (y < MAP.height - 1) push(index + MAP.width);
  }
  return reached;

  function push(neighbour) {
    if (seen[neighbour] === 1 || walkable[neighbour] !== 1) return;
    seen[neighbour] = 1;
    stack[top++] = neighbour;
  }
}

/**
 * Runs before a single byte is written: a generator bug that shipped a half-valid map would be
 * committed as an asset and only surface as a stranded region, a clamping camera or a door that
 * cannot be reached. Precedent and rationale: tools/generate-load-map.mjs,
 * tools/import-ninja-assets.mjs, docs/decisions.md 2026-08-26.
 */
function selfCheck(layers, firstgid, tileset, blockedTileIds) {
  const failures = [];
  const cellCount = MAP.width * MAP.height;
  const lastGid = firstgid + tileset.tilecount - 1;

  // Decoded exactly like the server's TiledMapLoader: gid 0, or a tile without `collides`, is
  // walkable. Counting `gid !== 0` instead would silently diverge from the server the first time
  // a decorative walkable tile lands on the collision layer.
  const walkable = new Uint8Array(cellCount);
  let walkableCells = 0;
  let blockingCells = 0;
  let uncollidableOnCollision = 0;
  let collidableOnGround = 0;
  let emptyGround = 0;
  let outOfRange = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const groundGid = layers.ground[index];
    if (groundGid === 0) {
      emptyGround += 1;
    } else if (groundGid < firstgid || groundGid > lastGid) {
      outOfRange += 1;
    } else if (blockedTileIds.has(groundGid - firstgid)) {
      collidableOnGround += 1;
    }

    const gid = layers.collision[index];
    if (gid === 0) {
      walkable[index] = 1;
      walkableCells += 1;
      continue;
    }
    if (gid < firstgid || gid > lastGid) {
      outOfRange += 1;
      continue;
    }
    if (blockedTileIds.has(gid - firstgid)) {
      blockingCells += 1;
    } else {
      uncollidableOnCollision += 1;
    }
  }

  if (outOfRange !== 0) {
    failures.push(
      `${outOfRange} cell(s) hold a gid outside the embedded tileset (${firstgid}..${lastGid})`,
    );
  }
  if (emptyGround !== 0) {
    failures.push(`${emptyGround} ground cells are empty (gid 0); every cell must draw a floor`);
  }
  if (collidableOnGround !== 0) {
    failures.push(
      `${collidableOnGround} ground cells hold a collides:true tile; the ground layer never blocks, ` +
        "so the art would promise a wall the server walks straight through",
    );
  }
  if (uncollidableOnCollision !== 0) {
    failures.push(
      `${uncollidableOnCollision} collision cells hold a tile that is not marked collides:true`,
    );
  }

  // Independent count, straight off the ASCII source: the interior blanks are the only walkable
  // cells the layout claims, so this catches both a mis-mapped legend and a band cell that came
  // out empty.
  const authored = COLLISION_ROWS.reduce(
    (total, row) => total + [...row].filter((character) => character === BLANK).length,
    0,
  );
  if (walkableCells !== authored) {
    failures.push(`walkable cells: counted ${walkableCells}, COLLISION_ROWS authors ${authored}`);
  }

  const spawnIndex = SPAWN.tileY * MAP.width + SPAWN.tileX;
  if (walkable[spawnIndex] !== 1) {
    failures.push(`spawn (${SPAWN.tileX}, ${SPAWN.tileY}) is not walkable`);
  } else {
    const reached = floodFill(walkable, spawnIndex);
    if (reached !== walkableCells) {
      failures.push(
        `connectivity: ${reached} of ${walkableCells} walkable cells reachable from the spawn, ` +
          `${walkableCells - reached} stranded`,
      );
    }
  }

  let walkableInBorder = 0;
  let longestRun = 0;
  let longestRunRow = -1;
  for (let y = 0; y < MAP.height; y += 1) {
    let run = 0;
    for (let x = 0; x < MAP.width; x += 1) {
      if (walkable[y * MAP.width + x] !== 1) {
        run = 0;
        continue;
      }
      if (isInBorder(x, y)) {
        walkableInBorder += 1;
      }
      run += 1;
      if (run > longestRun) {
        longestRun = run;
        longestRunRow = y;
      }
    }
  }
  if (walkableInBorder !== 0) {
    failures.push(`${walkableInBorder} walkable cells inside the border band; the camera would clamp`);
  }
  if (longestRun < MIN_OPEN_RUN) {
    failures.push(
      `longest straight walkable run is ${longestRun} tiles, need ${MIN_OPEN_RUN} ` +
        `(VIEW_RADIUS_TILES ${VIEW_RADIUS_TILES} + 2)`,
    );
  }

  const doorway = [
    ...PORTAL.triggers.map((tile) => ({ tile, role: "trigger" })),
    { tile: PORTAL.arrival, role: "arrival" },
  ];
  for (const { tile, role } of doorway) {
    if (walkable[tile.tileY * MAP.width + tile.tileX] !== 1) {
      failures.push(`portal ${role} (${tile.tileX}, ${tile.tileY}) is not walkable`);
    }
  }
  // Nothing outside this script can check that a trigger sits on the tile the art draws a door
  // on, so it is checked here while both are constants in the same file.
  for (const tile of PORTAL.triggers) {
    const gid = layers.ground[tile.tileY * MAP.width + tile.tileX];
    if (gid !== firstgid + TILE.woodDeck) {
      failures.push(
        `portal trigger (${tile.tileX}, ${tile.tileY}) is not on the doorway art (ground gid ${gid}, ` +
          `expected ${firstgid + TILE.woodDeck})`,
      );
    }
  }

  return { failures, walkableCells, blockingCells, longestRun, longestRunRow };
}

/* --------------------------------------------------------------- main ---- */

if (process.argv.length > 2) {
  fail(`unexpected argument ${JSON.stringify(process.argv[2])}; this script takes none`);
}

const { template, tileset, blockedTileIds } = readTileset();
const layers = buildLayers(tileset.firstgid);
const { failures, walkableCells, blockingCells, longestRun, longestRunRow } = selfCheck(
  layers,
  tileset.firstgid,
  tileset,
  blockedTileIds,
);
if (failures.length > 0) {
  console.error(`generate-plaza: ${failures.length} check(s) failed, nothing written:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

const map = {
  ...template,
  width: MAP.width,
  height: MAP.height,
  layers: [tileLayer("ground", 1, layers.ground), tileLayer("collision", 2, layers.collision)],
  nextlayerid: 3,
  nextobjectid: 1,
};

const target = resolve(CODE_DIR, MAP_FILE);
const contents = `${JSON.stringify(map)}\n`;
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, contents);

console.log(`wrote ${MAP_FILE} (${Buffer.byteLength(contents)} bytes)`);
console.log(`  ${MAP.width}x${MAP.height} tiles, walkable interior ${INTERIOR.width}x${INTERIOR.height}`);
console.log(
  `  border band left ${BORDER.left} / right ${BORDER.right} / top ${BORDER.top} / bottom ${BORDER.bottom}, ` +
    "no walkable cell inside it",
);
console.log(`  ${walkableCells} walkable / ${blockingCells} blocking, all walkable cells connected`);
console.log(`  longest straight walkable run ${longestRun} tiles on row ${longestRunRow} (need ${MIN_OPEN_RUN})`);
console.log(`  spawn (${SPAWN.tileX}, ${SPAWN.tileY})`);
console.log(
  `  south door triggers ${PORTAL.triggers.map((t) => `(${t.tileX}, ${t.tileY})`).join(" ")}, ` +
    `arrival (${PORTAL.arrival.tileX}, ${PORTAL.arrival.tileY})`,
);
