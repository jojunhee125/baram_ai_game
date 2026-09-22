import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cameraBorderTiles, VIEWPORT_HEIGHT_TILES, VIEWPORT_WIDTH_TILES } from "../shared/src/camera.ts";

const root = new URL("../", import.meta.url);
const template = JSON.parse(readFileSync(new URL("assets/maps/plaza.json", root), "utf8"));
const border = cameraBorderTiles(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES);
const width = border.left + 32 + border.right;
const height = border.top + 20 + border.bottom;
assert.equal(border.left, 16);
assert.equal(border.top, 8);
const tileset = template.tilesets[0];
const firstgid = tileset.firstgid;
const blockedIds = new Set(tileset.tiles.filter(tile => tile.properties?.some(p => p.name === "collides" && p.value)).map(tile => tile.id));
assert.equal(blockedIds.has(10), true);
for (const id of [2, 3, 4, 7]) assert.equal(blockedIds.has(id), false);

const groves = [
  [18, 10, 2, 4], [44, 10, 2, 4],
  [28, 8, 2, 2], [34, 8, 2, 2],
  [24, 15, 6, 2], [34, 15, 6, 2],
  [18, 21, 4, 2], [42, 21, 4, 2],
];
const ground = [];
const collision = [];
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const inside = x >= 16 && x <= 47 && y >= 8 && y <= 27;
    const tree = !inside || groves.some(([gx, gy, w, h]) => x >= gx && x < gx + w && y >= gy && y < gy + h);
    const trail = (x >= 30 && x <= 33) || (y >= 23 && y <= 25)
      || (y >= 13 && y <= 14 && x >= 20 && x <= 43)
      || ((x === 20 || x === 21 || x === 42 || x === 43) && y >= 14 && y <= 20);
    const door = y === 27 && (x === 31 || x === 32);
    ground.push(firstgid + (door ? 3 : trail && !tree ? 4 : (x * 7 + y * 11) % 13 === 0 ? 7 : 2));
    collision.push(tree ? firstgid + 10 : 0);
  }
}

const walkable = (x, y) => x >= 0 && x < width && y >= 0 && y < height && collision[y * width + x] === 0;
const queue = [[31, 24]];
const seen = new Set([24 * width + 31]);
for (let i = 0; i < queue.length; i++) {
  const [x, y] = queue[i];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy, key = ny * width + nx;
    if (walkable(nx, ny) && !seen.has(key)) { seen.add(key); queue.push([nx, ny]); }
  }
}
assert.equal(seen.size, collision.filter(gid => gid === 0).length, "all forest paths must connect");
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (!walkable(x, y)) continue;
    assert.ok(x >= 16 && x <= 47 && y >= 8 && y <= 27, "camera border must block");
    assert.ok([[-1, -1], [0, -1], [-1, 0], [0, 0]].some(([dx, dy]) =>
      walkable(x + dx, y + dy) && walkable(x + dx + 1, y + dy)
      && walkable(x + dx, y + dy + 1) && walkable(x + dx + 1, y + dy + 1)),
    `narrow passage at ${x},${y}`);
  }
}
const arrivals = [[31, 26], [31, 27], [32, 27]];
for (let y = 23; y <= 25; y++) for (let x = 30; x <= 32; x++) arrivals.push([x, y]);
const spawns = [
  [22, 12, 0, 1], [41, 12, 0, 1], [22, 19, 0, 1], [41, 19, 0, 1],
  [27, 12, 1, 3], [36, 12, 1, 3], [25, 18, 1, 3], [38, 18, 1, 3],
];
for (const [x, y] of arrivals) assert.ok(walkable(x, y), `blocked arrival ${x},${y}`);
for (const [x, y, wander, aggro] of spawns) {
  for (let dy = -wander; dy <= wander; dy++) for (let dx = -wander; dx <= wander; dx++) {
    assert.ok(walkable(x + dx, y + dy), `blocked monster range ${x + dx},${y + dy}`);
  }
  for (const [ax, ay] of arrivals) assert.ok(Math.max(Math.abs(x - ax), Math.abs(y - ay)) > wander + aggro, "unsafe arrival");
}
const layer = (name, id, data) => ({ data, height, id, name, opacity: 1, type: "tilelayer", visible: true, width, x: 0, y: 0 });
const map = { ...template, width, height, layers: [layer("ground", 1, ground), layer("collision", 2, collision)], nextlayerid: 3, nextobjectid: 1 };
const target = new URL("assets/maps/hunting-forest.json", root);
writeFileSync(target, `${JSON.stringify(map)}\n`);
console.log(`wrote ${fileURLToPath(target)}: ${width}x${height}, ${seen.size} connected walkable tiles, safe arrivals, no narrow passages`);
