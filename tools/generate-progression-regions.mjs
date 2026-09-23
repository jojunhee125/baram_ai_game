import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { PROGRESSION_CONNECTIONS, PROGRESSION_REGIONS } from "../shared/src/progression.ts";
import { cameraBorderTiles, VIEWPORT_HEIGHT_TILES, VIEWPORT_WIDTH_TILES } from "../shared/src/camera.ts";

const root = new URL("../", import.meta.url);
const template = JSON.parse(readFileSync(new URL("assets/maps/plaza.json", root), "utf8"));
const border = cameraBorderTiles(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES);
const width = border.left + 32 + border.right;
const height = border.top + 20 + border.bottom;
assert.deepEqual([border.left, border.top, width, height], [16, 8, 64, 37]);
const firstgid = template.tilesets[0].firstgid;
const layouts = {
  novice: [[18, 12, 2, 8], [30, 12, 2, 8], [44, 10, 2, 10]],
  rat: [[16, 8, 4, 4], [26, 8, 8, 4], [44, 8, 4, 4], [30, 14, 2, 8]],
  snake: [[18, 10, 2, 12], [30, 10, 2, 10], [44, 14, 2, 8]],
  bear: [[16, 8, 6, 4], [42, 8, 6, 4], [30, 12, 4, 10]],
  deer: [[16, 10, 4, 10], [44, 10, 4, 10], [30, 8, 4, 4]],
  pig: [[18, 10, 2, 10], [30, 16, 2, 6], [44, 10, 2, 10], [26, 8, 10, 4]],
  fox: [[16, 8, 4, 4], [44, 8, 4, 4], [30, 10, 2, 12], [18, 16, 2, 6], [44, 16, 2, 6]],
};
const spawnCoordinates = [[23, 14], [40, 14], [23, 19], [40, 19], [28, 14], [35, 14], [28, 19], [35, 19]];

for (const region of PROGRESSION_REGIONS) {
  const ground = [], collision = [];
  const exits = PROGRESSION_CONNECTIONS.filter(edge => edge.from.room === region.roomId).flatMap(edge => edge.from.tiles);
  const arrivals = PROGRESSION_CONNECTIONS.filter(edge => edge.to.room === region.roomId).map(edge => edge.to.arrival);
  const outdoor = region.theme === "novice" || region.theme === "deer";
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = x >= 16 && x <= 47 && y >= 8 && y <= 27;
    const blocked = !inside || layouts[region.theme].some(([bx, by, bw, bh]) => x >= bx && x < bx + bw && y >= by && y < by + bh);
    const door = exits.some(tile => tile.tileX === x && tile.tileY === y);
    const path = y >= 23 || (region.theme === "novice" && (x === 20 || x === 21 || x === 26 || x === 27 || x === 36 || x === 37 || x === 42 || x === 43));
    const variant = (x * 3 + y * 7) % 17 < 3;
    ground.push(firstgid + (door ? 3 : path ? 4 : outdoor ? variant ? 7 : 2 : variant ? 5 : 0));
    collision.push(blocked ? firstgid + (outdoor ? 10 : 9) : 0);
  }
  const walkable = (x, y) => x >= 0 && x < width && y >= 0 && y < height && collision[y * width + x] === 0;
  const queue = [[31, 24]], seen = new Set([24 * width + 31]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy, key = ny * width + nx;
      if (walkable(nx, ny) && !seen.has(key)) { seen.add(key); queue.push([nx, ny]); }
    }
  }
  assert.equal(seen.size, collision.filter(gid => gid === 0).length, `${region.roomId}: disconnected paths`);
  for (const [x, y] of queue) {
    assert.ok(x >= 16 && x <= 47 && y >= 8 && y <= 27, "camera border must block");
    assert.ok([[-1, -1], [0, -1], [-1, 0], [0, 0]].some(([dx, dy]) =>
      walkable(x + dx, y + dy) && walkable(x + dx + 1, y + dy) && walkable(x + dx, y + dy + 1) && walkable(x + dx + 1, y + dy + 1)), `${region.roomId}: narrow path at ${x},${y}`);
  }
  for (const tile of exits) assert.ok(walkable(tile.tileX, tile.tileY), `${region.roomId}: blocked exit`);
  for (const arrival of arrivals) {
    const radius = arrival.spreadRadiusInTiles ?? 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      assert.ok(walkable(arrival.tileX + dx, arrival.tileY + dy), `${region.roomId}: blocked arrival spread`);
    }
  }
  for (const [x, y] of [[31, 24], [28, 25], ...spawnCoordinates]) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.ok(walkable(x + dx, y + dy), `${region.roomId}: blocked NPC/spawn range ${x + dx},${y + dy}`);
  }
  const layer = (name, id, data) => ({ data, height, id, name, opacity: 1, type: "tilelayer", visible: true, width, x: 0, y: 0 });
  const map = { ...template, width, height, layers: [layer("ground", 1, ground), layer("collision", 2, collision)], nextlayerid: 3, nextobjectid: 1,
    properties: [{ name: "regionTheme", type: "string", value: region.theme }] };
  writeFileSync(new URL(`assets/maps/${region.roomId}.json`, root), `${JSON.stringify(map)}\n`);
  console.log(`${region.roomId}: ${width}x${height}, ${seen.size} connected walkable tiles; spawn/NPC/connection geometry verified`);
}
