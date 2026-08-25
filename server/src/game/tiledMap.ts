import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CollisionMap, MapLoader } from "../rooms/contracts";

const DEFAULT_MAPS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../../../assets/maps");

const COLLISION_LAYER_NAME = "collision";
const COLLIDES_PROPERTY_NAME = "collides";

/** Tiled packs flip/rotation flags into the top 3 gid bits; only the low 29 identify the tile. */
const GID_TILE_MASK = 0x1fffffff;

/** `mapKey` reaches the loader from room options, so it must never widen into a path. */
const SAFE_MAP_KEY = /^[a-z0-9_-]+$/i;

class TileGridCollisionMap implements CollisionMap {
  constructor(
    readonly widthInTiles: number,
    readonly heightInTiles: number,
    private readonly walkable: Uint8Array,
  ) {}

  isWalkable(tileX: number, tileY: number): boolean {
    // Bounds must be checked before indexing: a negative tileX would otherwise wrap
    // into the previous row and report that tile's walkability.
    if (tileX < 0 || tileY < 0 || tileX >= this.widthInTiles || tileY >= this.heightInTiles) {
      return false;
    }
    return this.walkable[tileY * this.widthInTiles + tileX] === 1;
  }
}

export class TiledMapLoader implements MapLoader {
  constructor(private readonly mapsDirectory: string = DEFAULT_MAPS_DIRECTORY) {}

  async load(mapKey: string): Promise<CollisionMap> {
    if (!SAFE_MAP_KEY.test(mapKey)) {
      throw new Error(`invalid mapKey ${JSON.stringify(mapKey)}: expected [a-z0-9_-]+`);
    }

    const path = join(this.mapsDirectory, `${mapKey}.json`);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (cause) {
      throw new Error(`failed to read map "${mapKey}" at ${path}`, { cause });
    }

    let json: unknown;
    try {
      json = JSON.parse(contents);
    } catch (cause) {
      throw new Error(`map "${mapKey}" at ${path} is not valid JSON`, { cause });
    }

    return parseCollisionMap(json, mapKey);
  }
}

function parseCollisionMap(json: unknown, mapKey: string): CollisionMap {
  const map = asRecord(json, `map "${mapKey}"`);
  const widthInTiles = asTileCount(map.width, `map "${mapKey}" width`);
  const heightInTiles = asTileCount(map.height, `map "${mapKey}" height`);

  const { firstgid, tilecount, blockedTileIds } = parseTileset(map.tilesets, mapKey);
  const cells = parseCollisionLayer(map.layers, mapKey, widthInTiles * heightInTiles);

  const walkable = new Uint8Array(cells.length);
  for (let index = 0; index < cells.length; index++) {
    const gid = cells[index];
    if (typeof gid !== "number" || !Number.isInteger(gid) || gid < 0) {
      throw new Error(
        `map "${mapKey}" layer "${COLLISION_LAYER_NAME}" cell ${index} is not a gid: ${String(gid)}`,
      );
    }
    if (gid === 0) {
      walkable[index] = 1;
      continue;
    }
    const tileId = (gid & GID_TILE_MASK) - firstgid;
    if (tileId < 0 || tileId >= tilecount) {
      throw new Error(
        `map "${mapKey}" layer "${COLLISION_LAYER_NAME}" cell ${index} has gid ${gid}, outside the embedded tileset (firstgid ${firstgid}, ${tilecount} tiles)`,
      );
    }
    walkable[index] = blockedTileIds.has(tileId) ? 0 : 1;
  }

  return new TileGridCollisionMap(widthInTiles, heightInTiles, walkable);
}

interface ParsedTileset {
  firstgid: number;
  tilecount: number;
  blockedTileIds: ReadonlySet<number>;
}

function parseTileset(tilesets: unknown, mapKey: string): ParsedTileset {
  if (!Array.isArray(tilesets) || tilesets.length !== 1) {
    throw new Error(
      `map "${mapKey}" must embed exactly one tileset, found ${Array.isArray(tilesets) ? tilesets.length : 0}`,
    );
  }
  const tileset = asRecord(tilesets[0], `map "${mapKey}" tileset`);
  if (typeof tileset.source === "string") {
    throw new Error(
      `map "${mapKey}" references an external tileset (${tileset.source}); embed the tileset in the map instead`,
    );
  }

  return {
    firstgid: asTileCount(tileset.firstgid, `map "${mapKey}" tileset firstgid`),
    tilecount: asTileCount(tileset.tilecount, `map "${mapKey}" tileset tilecount`),
    blockedTileIds: collectBlockedTileIds(tileset.tiles, mapKey),
  };
}

function collectBlockedTileIds(tiles: unknown, mapKey: string): ReadonlySet<number> {
  const blocked = new Set<number>();
  if (!Array.isArray(tiles)) {
    return blocked;
  }
  for (const tile of tiles) {
    if (!isRecord(tile) || !Array.isArray(tile.properties)) {
      continue;
    }
    const collides = tile.properties.some(
      (property) =>
        isRecord(property) && property.name === COLLIDES_PROPERTY_NAME && property.value === true,
    );
    if (!collides) {
      continue;
    }
    if (typeof tile.id !== "number" || !Number.isInteger(tile.id) || tile.id < 0) {
      throw new Error(
        `map "${mapKey}" tileset has a ${COLLIDES_PROPERTY_NAME} tile with an invalid id: ${String(tile.id)}`,
      );
    }
    blocked.add(tile.id);
  }
  return blocked;
}

function parseCollisionLayer(layers: unknown, mapKey: string, expectedCells: number): unknown[] {
  const layer = (Array.isArray(layers) ? layers : []).find(
    (candidate) => isRecord(candidate) && candidate.name === COLLISION_LAYER_NAME,
  );
  if (!isRecord(layer)) {
    throw new Error(`map "${mapKey}" has no "${COLLISION_LAYER_NAME}" layer`);
  }
  if (!Array.isArray(layer.data)) {
    throw new Error(
      `map "${mapKey}" layer "${COLLISION_LAYER_NAME}" has no plain tile array (encoding: ${String(layer.encoding ?? "none")}, compression: ${String(layer.compression ?? "none")}); re-export it as uncompressed CSV layer data`,
    );
  }
  if (layer.data.length !== expectedCells) {
    throw new Error(
      `map "${mapKey}" layer "${COLLISION_LAYER_NAME}" has ${layer.data.length} cells, expected ${expectedCells}`,
    );
  }
  return layer.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value;
}

function asTileCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${what} is not a positive integer: ${String(value)}`);
  }
  return value;
}
