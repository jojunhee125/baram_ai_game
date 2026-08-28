// Builds the Go/No-go PoC #2 load-test map (docs/poc2-design.md §1) into assets/maps/.
//
//   node tools/generate-load-map.mjs [--width 172] [--height 147] [--out assets/maps/grand-plaza.json]
//                                                                                    (cwd = code/)
//
// Every cell is a pure function of its coordinates - no randomness - so the same arguments
// always produce the same bytes. The smaller sizes exist for the density-controlled sweep in
// design §6.3, where map area has to scale with the bot count to hold neighbour count fixed.
//
// No art is authored here: the tileset block is copied verbatim out of assets/maps/plaza.json,
// so a reskin of plaza-tiles.png carries over without this script being touched.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VIEWPORT_HEIGHT_TILES, VIEWPORT_WIDTH_TILES, cameraBorderTiles } from "../shared/src/camera.ts";

const CODE_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEMPLATE_MAP = "assets/maps/plaza.json";

/**
 * Non-walkable margin, in tiles, that keeps the Phaser camera off its own `setBounds` clamp:
 * while no walkable tile lies inside it the local player stays exactly screen-centred, which is
 * what pins the visible Chebyshev distance at `maxVisibleTileDistance` and lets VIEW_RADIUS_TILES
 * be a true upper bound (design §1.3a). Derived, never restated: shared/src/camera.ts is the one
 * place that knows the viewport size and the avatar-origin asymmetry that makes `bottom` one row
 * thicker than `top`. At the current 32x18 viewport this is { 16, 16, 8, 9 }.
 */
const BORDER = cameraBorderTiles(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES);

/**
 * The map is sized from the interior out, not the other way round: the PoC #2 numbers on record
 * were measured on a 140x130 interior (14800 walkable cells), so holding it fixed is what keeps a
 * re-measurement comparable - otherwise density and view radius would both have moved and no
 * single-variable comparison is possible (docs/poc2-design.md §6.3). Widening the viewport
 * therefore grows the outer map (160x145 -> 172x147) and shifts every tile coordinate by the
 * border delta, while leaving the walkable layout byte-identical in shape.
 */
const INTERIOR_WIDTH = 140;
const INTERIOR_HEIGHT = 130;

const DEFAULT_WIDTH = INTERIOR_WIDTH + BORDER.left + BORDER.right;
const DEFAULT_HEIGHT = INTERIOR_HEIGHT + BORDER.top + BORDER.bottom;
const DEFAULT_OUT = "assets/maps/grand-plaza.json";

const SUPER_TILE = 10;
/** Leaves a 5-wide vertical and 6-tall horizontal corridor per super-tile, so buildings never touch. */
const BUILDING = { width: 5, height: 4 };
/** Super-tiles cleared of buildings at the map centre; becomes the spawn area and the clustering target. */
const PLAZA = { width: 4, height: 3 };

/** Tile ids in plaza-tiles.png: 0-7 walkable, 8-15 `collides: true` (assets/README.md). */
const TILE = {
  stoneFloor: 0,
  dirtPath: 4,
  medallion: 5,
  sand: 6,
  brickWall: 8,
  brickCorner: 9,
  water: 12,
};

/**
 * The only blocking tiles that are 100% opaque (assets/README.md): every other one lets the ground
 * layer show through, and `bush` - which this band used to be filled with - is literally the grass
 * texture at 67% alpha over grass ground, so the boundary rendered as lawn you could walk into.
 * A band cell a player can walk right up to therefore has to come from this set. It is a property
 * of the tileset, not of this layout, so it lists all three even though the band uses two.
 */
const OPAQUE_BLOCKERS = new Set([TILE.brickWall, TILE.brickCorner, TILE.water]);

/** Depth, in tiles, of the solid wall around the interior - and how far the check below looks. */
const BOUNDARY_RING_DEPTH = 2;

/* --------------------------------------------------------------- args ---- */

function parseArgs(argv) {
  const options = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      fail(`${flag}: missing value`);
    }
    switch (flag) {
      case "--width":
      case "--height": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) {
          fail(`${flag}: ${JSON.stringify(value)} is not an integer`);
        }
        options[flag.slice(2)] = parsed;
        break;
      }
      case "--out":
        options.out = value;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(flag)}`);
    }
    index += 1;
  }
  return options;
}

function fail(message) {
  console.error(`generate-load-map: ${message}`);
  process.exit(1);
}

/* ----------------------------------------------------------- geometry ---- */

function deriveGeometry(width, height) {
  const interiorWidth = width - BORDER.left - BORDER.right;
  const interiorHeight = height - BORDER.top - BORDER.bottom;
  if (interiorWidth <= 0 || interiorHeight <= 0) {
    fail(`${width}x${height} leaves no interior inside the ${JSON.stringify(BORDER)} border`);
  }
  if (interiorWidth % SUPER_TILE !== 0 || interiorHeight % SUPER_TILE !== 0) {
    fail(
      `interior ${interiorWidth}x${interiorHeight} is not a whole number of ${SUPER_TILE}x${SUPER_TILE} super-tiles; ` +
        `pick width/height so that width-${BORDER.left + BORDER.right} and height-${BORDER.top + BORDER.bottom} are multiples of ${SUPER_TILE}`,
    );
  }

  const superCountX = interiorWidth / SUPER_TILE;
  const superCountY = interiorHeight / SUPER_TILE;
  if (superCountX < PLAZA.width || superCountY < PLAZA.height) {
    fail(
      `interior is ${superCountX}x${superCountY} super-tiles, too small for the ${PLAZA.width}x${PLAZA.height} central plaza`,
    );
  }

  const plazaI0 = Math.floor((superCountX - PLAZA.width) / 2);
  const plazaJ0 = Math.floor((superCountY - PLAZA.height) / 2);
  const buildings = superCountX * superCountY - PLAZA.width * PLAZA.height;

  return {
    width,
    height,
    interiorWidth,
    interiorHeight,
    superCountX,
    superCountY,
    plazaI0,
    plazaJ0,
    walkableCells: interiorWidth * interiorHeight - buildings * BUILDING.width * BUILDING.height,
    spawn: {
      tileX: BORDER.left + (plazaI0 + PLAZA.width / 2) * SUPER_TILE,
      tileY: BORDER.top + (plazaJ0 + PLAZA.height / 2) * SUPER_TILE,
    },
  };
}

function isInBorder(x, y, geometry) {
  return (
    x < BORDER.left ||
    x >= geometry.width - BORDER.right ||
    y < BORDER.top ||
    y >= geometry.height - BORDER.bottom
  );
}

/** How many tiles into the border band (x, y) lies; 0 for an interior cell. */
function bandDepth(x, y, geometry) {
  const interiorRight = geometry.width - BORDER.right;
  const interiorBottom = geometry.height - BORDER.bottom;
  const outX = x < BORDER.left ? BORDER.left - x : x >= interiorRight ? x - interiorRight + 1 : 0;
  const outY = y < BORDER.top ? BORDER.top - y : y >= interiorBottom ? y - interiorBottom + 1 : 0;
  return Math.max(outX, outY);
}

/** `null` collision means an empty cell (gid 0), i.e. walkable. */
function cellAt(x, y, geometry) {
  if (isInBorder(x, y, geometry)) {
    // A city wall thick enough to read as one, then open water out to the map edge. The band used
    // to be one course of brick over a lawn of `bush`, which is the grass texture at 67% alpha:
    // from inside, the world simply looked like it kept going.
    return bandDepth(x, y, geometry) <= BOUNDARY_RING_DEPTH
      ? { ground: TILE.stoneFloor, collision: TILE.brickWall }
      : { ground: TILE.sand, collision: TILE.water };
  }

  const localX = x - BORDER.left;
  const localY = y - BORDER.top;
  const superX = Math.floor(localX / SUPER_TILE);
  const superY = Math.floor(localY / SUPER_TILE);
  if (
    superX >= geometry.plazaI0 &&
    superX < geometry.plazaI0 + PLAZA.width &&
    superY >= geometry.plazaJ0 &&
    superY < geometry.plazaJ0 + PLAZA.height
  ) {
    return { ground: TILE.medallion, collision: null };
  }

  if (localX % SUPER_TILE < BUILDING.width && localY % SUPER_TILE < BUILDING.height) {
    return { ground: TILE.stoneFloor, collision: TILE.brickWall };
  }
  return { ground: TILE.dirtPath, collision: null };
}

/* ----------------------------------------------------------- template ---- */

function readTemplate() {
  const path = resolve(CODE_DIR, TEMPLATE_MAP);
  let template;
  try {
    template = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(`cannot read the format template ${TEMPLATE_MAP} at ${path}: ${cause.message}`);
  }
  if (!Array.isArray(template.tilesets) || template.tilesets.length !== 1) {
    fail(`${TEMPLATE_MAP} must embed exactly one tileset to copy`);
  }
  const [tileset] = template.tilesets;
  if (!Number.isInteger(tileset.firstgid) || tileset.firstgid <= 0) {
    fail(`${TEMPLATE_MAP} tileset firstgid is ${String(tileset.firstgid)}, expected a positive integer`);
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

function buildLayers(geometry, firstgid) {
  const cellCount = geometry.width * geometry.height;
  const ground = new Array(cellCount);
  const collision = new Array(cellCount);
  for (let y = 0; y < geometry.height; y += 1) {
    for (let x = 0; x < geometry.width; x += 1) {
      const index = y * geometry.width + x;
      const cell = cellAt(x, y, geometry);
      ground[index] = firstgid + cell.ground;
      collision[index] = cell.collision === null ? 0 : firstgid + cell.collision;
    }
  }
  return { ground, collision };
}

function tileLayer(name, id, data, geometry) {
  return {
    data,
    height: geometry.height,
    id,
    name,
    opacity: 1,
    type: "tilelayer",
    visible: true,
    width: geometry.width,
    x: 0,
    y: 0,
  };
}

/* --------------------------------------------------------- self-check ---- */

/**
 * Runs before a single byte is written: a generator bug that shipped a half-valid map would be
 * committed as an asset and only surface as an unreachable region under load test. Precedent and
 * rationale: tools/import-ninja-assets.mjs, docs/decisions.md 2026-08-26.
 */
function selfCheck(layers, geometry, firstgid, blockedTileIds) {
  const failures = [];
  const cellCount = geometry.width * geometry.height;

  // Decoded exactly like the server's TiledMapLoader: gid 0 or a tile without `collides` is
  // walkable. Checking `gid !== 0` instead would silently diverge from the server the first
  // time a decorative walkable tile lands on the collision layer.
  const walkable = new Uint8Array(cellCount);
  let emptyCells = 0;
  let blockedCells = 0;
  let mismatched = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const gid = layers.collision[index];
    if (gid === 0) {
      emptyCells += 1;
      walkable[index] = 1;
      continue;
    }
    if (blockedTileIds.has(gid - firstgid)) {
      blockedCells += 1;
    } else {
      mismatched += 1;
    }
  }

  if (emptyCells !== geometry.walkableCells) {
    failures.push(`walkable cells: counted ${emptyCells}, derived ${geometry.walkableCells}`);
  }
  if (blockedCells !== cellCount - geometry.walkableCells) {
    failures.push(`blocking cells: counted ${blockedCells}, derived ${cellCount - geometry.walkableCells}`);
  }
  if (mismatched !== 0) {
    failures.push(`${mismatched} collision cells hold a tile that is not marked collides:true`);
  }

  const spawnIndex = geometry.spawn.tileY * geometry.width + geometry.spawn.tileX;
  if (walkable[spawnIndex] !== 1) {
    failures.push(`spawn centre (${geometry.spawn.tileX}, ${geometry.spawn.tileY}) is not walkable`);
  } else {
    const reached = floodFill(walkable, geometry, spawnIndex);
    if (reached !== emptyCells) {
      failures.push(
        `connectivity: ${reached} of ${emptyCells} walkable cells reachable from the spawn centre, ${emptyCells - reached} stranded`,
      );
    }
  }

  let walkableInBorder = 0;
  for (let y = 0; y < geometry.height; y += 1) {
    for (let x = 0; x < geometry.width; x += 1) {
      if (isInBorder(x, y, geometry) && walkable[y * geometry.width + x] === 1) {
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
  for (let y = 0; y < geometry.height; y += 1) {
    for (let x = 0; x < geometry.width; x += 1) {
      if (!isInBorder(x, y, geometry) || !nearWalkable(walkable, geometry, x, y)) continue;
      const id = layers.collision[y * geometry.width + x] - firstgid;
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

  return { failures, emptyCells, blockedCells };
}

/** True if any walkable cell lies within BOUNDARY_RING_DEPTH tiles (Chebyshev) of (x, y). */
function nearWalkable(walkable, geometry, x, y) {
  const toY = Math.min(geometry.height - 1, y + BOUNDARY_RING_DEPTH);
  const toX = Math.min(geometry.width - 1, x + BOUNDARY_RING_DEPTH);
  for (let ny = Math.max(0, y - BOUNDARY_RING_DEPTH); ny <= toY; ny += 1) {
    for (let nx = Math.max(0, x - BOUNDARY_RING_DEPTH); nx <= toX; nx += 1) {
      if (walkable[ny * geometry.width + nx] === 1) return true;
    }
  }
  return false;
}

function floodFill(walkable, geometry, startIndex) {
  const seen = new Uint8Array(walkable.length);
  const stack = new Int32Array(walkable.length);
  let top = 0;
  stack[top++] = startIndex;
  seen[startIndex] = 1;
  let reached = 0;
  while (top > 0) {
    const index = stack[--top];
    reached += 1;
    const x = index % geometry.width;
    const y = (index - x) / geometry.width;
    if (x > 0) push(index - 1);
    if (x < geometry.width - 1) push(index + 1);
    if (y > 0) push(index - geometry.width);
    if (y < geometry.height - 1) push(index + geometry.width);
  }
  return reached;

  function push(neighbour) {
    if (seen[neighbour] === 1 || walkable[neighbour] !== 1) return;
    seen[neighbour] = 1;
    stack[top++] = neighbour;
  }
}

/* --------------------------------------------------------------- main ---- */

const options = parseArgs(process.argv.slice(2));
const geometry = deriveGeometry(options.width, options.height);
const { template, tileset, blockedTileIds } = readTemplate();
const layers = buildLayers(geometry, tileset.firstgid);

const { failures, emptyCells, blockedCells } = selfCheck(layers, geometry, tileset.firstgid, blockedTileIds);
if (failures.length > 0) {
  console.error(`generate-load-map: ${failures.length} check(s) failed, nothing written:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

const map = {
  ...template,
  width: geometry.width,
  height: geometry.height,
  layers: [
    tileLayer("ground", 1, layers.ground, geometry),
    tileLayer("collision", 2, layers.collision, geometry),
  ],
  nextlayerid: 3,
  nextobjectid: 1,
};

const target = resolve(CODE_DIR, options.out);
const contents = `${JSON.stringify(map)}\n`;
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, contents);

console.log(`wrote ${options.out} (${Buffer.byteLength(contents)} bytes)`);
console.log(`  ${geometry.width}x${geometry.height} tiles, interior ${geometry.interiorWidth}x${geometry.interiorHeight}`);
console.log(`  ${geometry.superCountX}x${geometry.superCountY} super-tiles, plaza at super-tile (${geometry.plazaI0}, ${geometry.plazaJ0})`);
console.log(`  ${emptyCells} walkable / ${blockedCells} blocking, all walkable cells connected`);
console.log(`  spawn centre (${geometry.spawn.tileX}, ${geometry.spawn.tileY})`);
