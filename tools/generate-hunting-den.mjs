// Builds the hunting den map - the room behind hunting-ground's north door - into
// assets/maps/hunting-den.json.
//
//   node tools/generate-hunting-den.mjs        (cwd = code/)
//
// A straight copy of tools/generate-hunting-ground.mjs's structure and reasons (see that file's
// header) with one difference: this room has a single door, its own south door, which is both
// where a player leaves towards hunting-ground and where a player arrives coming from
// hunting-ground's north door. Both directions share one physical doorway, so PORTAL below bundles
// trigger and arrival together the same way the other generator's south door does.
//
// No art is authored here either: the tileset block is copied out of assets/maps/plaza.json, so a
// reskin of plaza-tiles.png carries over without this script being touched.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VIEWPORT_HEIGHT_TILES, VIEWPORT_WIDTH_TILES, cameraBorderTiles } from "../shared/src/camera.ts";

const CODE_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** Read for its tileset block, never written. */
const TEMPLATE_MAP = "assets/maps/plaza.json";
const MAP_FILE = "assets/maps/hunting-den.json";

function fail(message) {
  console.error(`generate-hunting-den: ${message}`);
  process.exit(1);
}

/**
 * Non-walkable margin, in tiles, that keeps the Phaser camera off its own `setBounds` clamp.
 * While no walkable tile lies inside it the local player stays exactly screen-centred, which is
 * the invariant VIEW_RADIUS_TILES is derived from (shared/src/camera.ts).
 */
const BORDER = cameraBorderTiles(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES);

/* --------------------------------------------------------------- tiles ---- */

/** Tile ids in plaza-tiles.png: 0-7 walkable, 8-15 `collides: true` (assets/README.md). */
const TILE = {
  stoneFloor: 0,
  stoneCracked: 1,
  grass: 2,
  woodDeck: 3,
  dirtPath: 4,
  sand: 6,
  flowerGrass: 7,
  brickWall: 8,
  brickCorner: 9,
  treeStump: 10,
  bush: 11,
  water: 12,
  mossyRock: 15,
};

const GROUND_LEGEND = {
  g: TILE.stoneFloor,
  f: TILE.stoneCracked,
  d: TILE.stoneCracked,
  s: TILE.sand,
  w: TILE.woodDeck,
};

/**
 * The only blocking tiles that are 100% opaque (assets/README.md): every other one lets the ground
 * layer show through, and `bush` is literally the grass texture at 67% alpha. A band cell a player
 * can walk right up to therefore has to come from this set, or the art draws lawn over what the
 * server treats as a wall and the edge of the world reads as somewhere you could keep going.
 */
const OPAQUE_BLOCKERS = new Set([TILE.brickWall, TILE.brickCorner, TILE.water]);

/** Depth, in tiles, of the solid ring around the interior - and how far the check below looks. */
const BOUNDARY_RING_DEPTH = 2;

const COLLISION_LEGEND = {
  P: TILE.mossyRock,
  H: TILE.mossyRock,
  N: TILE.mossyRock,
  "~": TILE.mossyRock,
};

/** In COLLISION_ROWS only: no tile at all (gid 0), i.e. a walkable cell. */
const BLANK = ".";

/* ------------------------------------------------------------ interior ---- */

/**
 * The walkable area: 32x20, smaller than hunting-ground (40x24) on purpose - this room is one
 * layer deeper, found only by walking hunting-ground's own trail to its north end
 * (`docs/design-phase-e-second-hunting-ground.md` §3.1). Still wider and taller than one
 * screenful (32x18): a hunting ground is walked around rather than surveyed from the entrance.
 *
 * An open rocky cave: stone ribs sit in
 * isolated 2-tile-deep clumps, with at least two open tiles between any two of them, between a
 * clump and the trail, and between a clump and the enclosing wall. `narrowPassages` below is that
 * spacing rule enforced, not trusted by eye.
 *
 * A two-tile dirt trail runs the full height at interior cols 15-16 (map x 31-32), continuing the
 * line of hunting-ground's own trail through its north door. It widens into the doorway threshold
 * on the last row, which is this room's only exit.
 */
const INTERIOR_WIDTH = 32;
const INTERIOR_HEIGHT = 20;

const GROUND_ROWS = [
  "gggggfgggggggggddggggggggggggggg",
  "gggggggggggggggddggggggggggggggg",
  "gggggggggggggggddgggggggfggggggg",
  "gggggggggggggggddggggggggggggggg",
  "ggggggggggggfggddggggggggggggggg",
  "gggggggggggggggddggggggggggggggg",
  "gggggggggggggggddgggggggggggfggg",
  "gggggggggggggggddggggggggggggggg",
  "gggfgggggggggggddggggggggggggggg",
  "gggggggggggggggddggggggggggggggg",
  "gggggggggggggggddggfgggggggggggg",
  "gggggggggggggggddggggggggggggggg",
  "gggggggggfgggggddggggggggggggggg",
  "gggggggggggggggddggggggggggggggg",
  "gggggggggggggggddggggggggggfgggg",
  "gggggggggggggggddggggggggggggggg",
  "ggggggggggggggfddggggggggggggggg",
  "gggggggggggggggddggggggggggggggg",
  "gggggggggggggggddgggggggggggggfg",
  "gggggggggggggddwwddggggggggggggg",
];

const COLLISION_ROWS = [
  "................................",
  "................................",
  "................................",
  "..NN....PP..........HH....NN....",
  "..NN....PP..........HH....NN....",
  "................................",
  "................................",
  "..NNNNNN..............NNNNNN....",
  "..NNNNNN..............NNNNNN....",
  "................................",
  "................................",
  "................................",
  "................................",
  "...PP....~~..........NN....HH...",
  "...PP....~~..........NN....HH...",
  "................................",
  "................................",
  "................................",
  "................................",
  "................................",
];

/* ------------------------------------------------------------ scenery ---- */

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

if (interiorGround.width !== INTERIOR_WIDTH || interiorGround.height !== INTERIOR_HEIGHT) {
  fail(
    `the walkable area is ${interiorGround.width}x${interiorGround.height}, but the design fixes it at ` +
      `${INTERIOR_WIDTH}x${INTERIOR_HEIGHT}; every portal and spawn coordinate below is derived from that size`,
  );
}

const INTERIOR = { width: interiorGround.width, height: interiorGround.height };
const MAP = {
  width: BORDER.left + INTERIOR.width + BORDER.right,
  height: BORDER.top + INTERIOR.height + BORDER.bottom,
};

/**
 * Recorded here because the layout is built around them: the room spawn sits one tile north of
 * the door's arrival tile, and the door itself is the room's only exit. The authoritative copies
 * live in server/src/rooms/definitions.ts and portalDefinitions.ts - the checks below only prove
 * this map can carry them.
 *
 * Unlike hunting-ground's PORTAL, which describes its south door's two directions of travel
 * (trigger = leaving south, arrival = landing when entering from plaza), this room's PORTAL
 * describes its *only* door the same way: `triggers` fire hunting-den-south-door towards
 * hunting-ground, and `arrival` is where hunting-ground-north-door lands a player coming in.
 */
const SPAWN = { tileX: 31, tileY: 24 };
const PORTAL = {
  triggers: [
    { tileX: 31, tileY: 27 },
    { tileX: 32, tileY: 27 },
  ],
  arrival: { tileX: 31, tileY: 26 },
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

  // The rings closest to the interior are the rampart that encloses the ground, corners included,
  // at BOUNDARY_RING_DEPTH rather than one tile so the boundary reads as masonry from inside
  // instead of as the first row of the forest behind it.
  if (Math.max(outX, outY) <= BOUNDARY_RING_DEPTH) {
    return {
      ground: TILE.stoneFloor,
      collision: outX >= 1 && outY >= 1 ? TILE.brickCorner : TILE.brickWall,
    };
  }

  return { ground: TILE.stoneFloor, collision: scatter(x, y, 4) % 3 === 0 ? TILE.brickCorner : TILE.brickWall };
}

/* ----------------------------------------------------------- template ---- */

function readTileset() {
  const path = resolve(CODE_DIR, TEMPLATE_MAP);
  let template;
  try {
    template = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(
      `cannot read the format template ${TEMPLATE_MAP} at ${path}: ${cause.message}\n` +
        "  the tileset block is authored by tools/import-ninja-assets.mjs, not by this script;\n" +
        "  restore the file from git before regenerating the layout",
    );
  }
  if (!Array.isArray(template.tilesets) || template.tilesets.length !== 1) {
    fail(`${TEMPLATE_MAP} must embed exactly one tileset to copy`);
  }
  const [tileset] = template.tilesets;
  if (!Number.isInteger(tileset.firstgid) || tileset.firstgid <= 0) {
    fail(`${TEMPLATE_MAP} tileset firstgid is ${String(tileset.firstgid)}, expected a positive integer`);
  }
  if (!Number.isInteger(tileset.tilecount) || tileset.tilecount <= 0) {
    fail(`${TEMPLATE_MAP} tileset tilecount is ${String(tileset.tilecount)}, expected a positive integer`);
  }
  const blockedTileIds = new Set(
    (tileset.tiles ?? [])
      .filter((tile) => (tile.properties ?? []).some((p) => p.name === "collides" && p.value === true))
      .map((tile) => tile.id),
  );
  for (const [name, id] of Object.entries(TILE)) {
    if (id < 0 || id >= tileset.tilecount) {
      fail(`${TEMPLATE_MAP} tileset holds ${tileset.tilecount} tiles, but this script uses ${name} = id ${id}`);
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
      ground[index] = firstgid + (x === 47 && (y === 25 || y === 26) ? TILE.woodDeck : cell.ground);
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

/** True if any walkable cell lies within BOUNDARY_RING_DEPTH tiles (Chebyshev) of (x, y). */
function nearWalkable(walkable, x, y) {
  const fromY = Math.max(0, y - BOUNDARY_RING_DEPTH);
  const toY = Math.min(MAP.height - 1, y + BOUNDARY_RING_DEPTH);
  const fromX = Math.max(0, x - BOUNDARY_RING_DEPTH);
  const toX = Math.min(MAP.width - 1, x + BOUNDARY_RING_DEPTH);
  for (let ny = fromY; ny <= toY; ny += 1) {
    for (let nx = fromX; nx <= toX; nx += 1) {
      if (walkable[ny * MAP.width + nx] === 1) return true;
    }
  }
  return false;
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
 * Every walkable cell that belongs to no fully walkable 2x2 block, i.e. every tile that can only
 * be left along one axis. Those are the one-tile corridors and dead ends a greedy chaser gets
 * stuck oscillating in, so the layout above is authored to have none and this proves it.
 */
function narrowPassages(walkable) {
  const found = [];
  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      if (walkable[y * MAP.width + x] !== 1) continue;
      let wide = false;
      for (const [dx, dy] of [
        [-1, -1],
        [0, -1],
        [-1, 0],
        [0, 0],
      ]) {
        const x0 = x + dx;
        const y0 = y + dy;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= MAP.width || y0 + 1 >= MAP.height) continue;
        if (
          walkable[y0 * MAP.width + x0] === 1 &&
          walkable[y0 * MAP.width + x0 + 1] === 1 &&
          walkable[(y0 + 1) * MAP.width + x0] === 1 &&
          walkable[(y0 + 1) * MAP.width + x0 + 1] === 1
        ) {
          wide = true;
          break;
        }
      }
      if (!wide) found.push(`(${x}, ${y})`);
    }
  }
  return found;
}

/**
 * Runs before a single byte is written: a generator bug that shipped a half-valid map would be
 * committed as an asset and only surface as a stranded region, a clamping camera or a door that
 * cannot be reached. Precedent and rationale: tools/generate-plaza.mjs,
 * tools/generate-hunting-ground.mjs, tools/generate-load-map.mjs, docs/decisions.md 2026-08-26.
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
  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      if (isInBorder(x, y) && walkable[y * MAP.width + x] === 1) {
        walkableInBorder += 1;
      }
    }
  }
  if (walkableInBorder !== 0) {
    failures.push(`${walkableInBorder} walkable cells inside the border band; the camera would clamp`);
  }

  // The band is scenery nobody can enter, but its innermost rings are the only thing that tells a
  // player where the world stops, and a translucent blocker there shows the ground layer through
  // and reads as more of the floor. Nothing at runtime can catch this: the server blocks the cell
  // either way, so the map is "correct" while the art invites you to walk into it.
  let seeThroughBoundary = 0;
  let firstSeeThrough = "";
  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      if (!isInBorder(x, y) || !nearWalkable(walkable, x, y)) continue;
      const id = layers.collision[y * MAP.width + x] - firstgid;
      if (OPAQUE_BLOCKERS.has(id)) continue;
      seeThroughBoundary += 1;
      if (firstSeeThrough === "") firstSeeThrough = `(${x}, ${y}) holds tile id ${id}`;
    }
  }
  if (seeThroughBoundary !== 0) {
    failures.push(
      `${seeThroughBoundary} band cell(s) within ${BOUNDARY_RING_DEPTH} tiles of walkable ground are not ` +
        `one of the opaque blockers ${[...OPAQUE_BLOCKERS].join("/")}; first: ${firstSeeThrough}`,
    );
  }

  const narrow = narrowPassages(walkable);
  if (narrow.length !== 0) {
    failures.push(
      `${narrow.length} walkable cell(s) sit in a one-tile-wide passage, where a greedy chaser ` +
        `oscillates; first: ${narrow.slice(0, 5).join(" ")}`,
    );
  }

  const doorway = [
    { tile: { tileX: 47, tileY: 25 }, role: "forest trigger" },
    { tile: { tileX: 47, tileY: 26 }, role: "forest trigger" },
    { tile: { tileX: 46, tileY: 25 }, role: "forest arrival" },
    ...PORTAL.triggers.map((tile) => ({ tile, role: "trigger" })),
    { tile: PORTAL.arrival, role: "arrival" },
  ];
  for (const { tile, role } of doorway) {
    if (walkable[tile.tileY * MAP.width + tile.tileX] !== 1) {
      failures.push(`portal ${role} (${tile.tileX}, ${tile.tileY}) is not walkable`);
    }
  }
  // Nothing outside this script can check that a trigger sits on the tile the art draws a door
  // on, so it is checked here while both are constants in the same file. This room's own south
  // door, unlike hunting-ground's, is the room's only doorway - there is no second door to check.
  for (const tile of PORTAL.triggers) {
    const gid = layers.ground[tile.tileY * MAP.width + tile.tileX];
    if (gid !== firstgid + TILE.woodDeck) {
      failures.push(
        `portal trigger (${tile.tileX}, ${tile.tileY}) is not on the doorway art (ground gid ${gid}, ` +
          `expected ${firstgid + TILE.woodDeck})`,
      );
    }
  }

  return { failures, walkableCells, blockingCells };
}

/* --------------------------------------------------------------- main ---- */

if (process.argv.length > 2) {
  fail(`unexpected argument ${JSON.stringify(process.argv[2])}; this script takes none`);
}

const { template, tileset, blockedTileIds } = readTileset();
const layers = buildLayers(tileset.firstgid);
const { failures, walkableCells, blockingCells } = selfCheck(
  layers,
  tileset.firstgid,
  tileset,
  blockedTileIds,
);
if (failures.length > 0) {
  console.error(`generate-hunting-den: ${failures.length} check(s) failed, nothing written:`);
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
console.log("  no walkable cell sits in a one-tile-wide passage");
console.log(`  spawn (${SPAWN.tileX}, ${SPAWN.tileY})`);
console.log(
  `  south door triggers ${PORTAL.triggers.map((t) => `(${t.tileX}, ${t.tileY})`).join(" ")}, ` +
    `arrival (${PORTAL.arrival.tileX}, ${PORTAL.arrival.tileY})`,
);
