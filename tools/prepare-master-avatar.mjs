// Compiles the curated native pixel grid; the generated reference is never resized into runtime art.
// Run from any directory: node tools/prepare-master-avatar.mjs [--check]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Canvas, composite, crop, decodePng, encodePng, upscale } from "./lib/png.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = resolve(ROOT, "tools/art-source/master-adventurer/pixels.json");
const DIRECTIONS = ["down", "left", "right", "up"];
const POSES = ["idle", "left-step", "passing", "right-step"];
const FRAME_SIZE = 48;
const FOOT = [24, 46];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compile(source) {
  if (source.version !== 1 || source.frameSize !== FRAME_SIZE ||
      JSON.stringify(source.foot) !== JSON.stringify(FOOT)) {
    throw new Error("Master source must use version 1, 48px frames and foot (24, 46)");
  }
  const palette = new Map(Object.entries(source.palette).map(([symbol, hex]) => {
    if (symbol.length !== 1 || !/^[A-Za-z0-9.]$/.test(symbol)) {
      throw new Error(`Invalid palette symbol: ${symbol}`);
    }
    if (symbol === "." && hex === null) return [symbol, [0, 0, 0, 0]];
    if (typeof hex !== "string" || !/^#[a-f0-9]{6}$/i.test(hex)) {
      throw new Error(`Invalid palette color: ${symbol}`);
    }
    return [symbol, [...hex.slice(1).match(/../g).map((byte) => Number.parseInt(byte, 16)), 255]];
  }));
  if (!palette.has(".") || palette.get(".")[3] !== 0 || palette.size > 24) {
    throw new Error("Master palette requires transparent '.' and at most 23 opaque colors");
  }
  if (source.frames.length !== 16) throw new Error("Master source requires sixteen frames");

  const atlas = new Canvas(FRAME_SIZE * 4, FRAME_SIZE * 4);
  const frames = [];
  const hashes = new Set();
  for (const [index, frame] of source.frames.entries()) {
    const direction = DIRECTIONS[Math.floor(index / 4)];
    const pose = POSES[index % 4];
    const label = `${direction}/${pose}`;
    if (frame.direction !== direction || frame.pose !== pose) {
      throw new Error(`Frame ${index} must be ${label}`);
    }
    if (!Array.isArray(frame.origin) || frame.origin.length !== 2 ||
        !frame.origin.every(Number.isInteger) || !Array.isArray(frame.pixels) || !frame.pixels.length) {
      throw new Error(`${label}: invalid origin or pixel grid`);
    }
    const [offsetX, offsetY] = frame.origin;
    const width = frame.pixels[0].length;
    if (offsetX < 1 || offsetY < 1 || offsetX + width >= FRAME_SIZE ||
        offsetY + frame.pixels.length > FOOT[1]) {
      throw new Error(`${label}: pixel grid touches a frame edge or exceeds its foot line`);
    }
    const canvas = new Canvas(FRAME_SIZE, FRAME_SIZE);
    const occupied = new Set();
    let bottom = -1;
    for (const [y, row] of frame.pixels.entries()) {
      if (typeof row !== "string" || row.length !== width) {
        throw new Error(`${label}: inconsistent grid width at row ${y}`);
      }
      for (const [x, symbol] of [...row].entries()) {
        const rgba = palette.get(symbol);
        if (!rgba) throw new Error(`${label}: unknown palette symbol '${symbol}' at ${x},${y}`);
        canvas.data.set(rgba, canvas.at(offsetX + x, offsetY + y));
        if (rgba[3]) {
          occupied.add((offsetY + y) * FRAME_SIZE + offsetX + x);
          bottom = Math.max(bottom, offsetY + y);
        }
      }
    }
    if (bottom !== FOOT[1] - 1 || occupied.size < 250) {
      throw new Error(`${label}: empty/small frame or unstable foot anchor (bottom ${bottom})`);
    }
    const pending = [occupied.values().next().value];
    const connected = new Set(pending);
    while (pending.length) {
      const pixel = pending.pop();
      const x = pixel % FRAME_SIZE;
      const y = Math.floor(pixel / FRAME_SIZE);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const neighbor = (y + dy) * FRAME_SIZE + x + dx;
          if (x + dx < 0 || x + dx >= FRAME_SIZE || y + dy < 0 || y + dy >= FRAME_SIZE) continue;
          if (occupied.has(neighbor) && !connected.has(neighbor)) {
            connected.add(neighbor);
            pending.push(neighbor);
          }
        }
      }
    }
    if (connected.size !== occupied.size) throw new Error(`${label}: detached pixels/specks`);
    const hash = digest(canvas.data);
    if (hashes.has(hash)) throw new Error(`${label}: duplicate animation frame`);
    hashes.add(hash);
    atlas.blit(canvas, (index % 4) * FRAME_SIZE, Math.floor(index / 4) * FRAME_SIZE);
    frames.push(canvas);
  }
  return { atlas, frames, colors: palette.size - 1 };
}

function checker(width, height) {
  const canvas = new Canvas(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? [60, 70, 74] : [49, 59, 64];
      canvas.data.set([...color, 255], canvas.at(x, y));
    }
  }
  return canvas;
}

function resizeLegacy(source) {
  const resized = new Canvas(FRAME_SIZE, FRAME_SIZE);
  for (let y = 0; y < FRAME_SIZE; y += 1) {
    for (let x = 0; x < FRAME_SIZE; x += 1) {
      const from = source.at(Math.floor((x + 0.5) * source.width / FRAME_SIZE),
        Math.floor((y + 0.5) * source.height / FRAME_SIZE));
      resized.data.set(source.data.subarray(from, from + 4), resized.at(x, y));
    }
  }
  return resized;
}

function comparison(frames) {
  const legacy = decodePng(readFileSync(resolve(ROOT, "assets/sprites/heritage-adventurer.png")), "legacy avatar");
  if (legacy.width !== 1086 || legacy.height !== 1448) throw new Error("Unexpected legacy sheet geometry");
  const canvas = checker(FRAME_SIZE * 6, FRAME_SIZE * 4);
  for (let row = 0; row < 4; row += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      canvas.data.set([182, 148, 75, 255], canvas.at(x, row * FRAME_SIZE + FOOT[1]));
    }
    const layer = new Canvas(canvas.width, canvas.height);
    layer.blit(resizeLegacy(crop(legacy, 362, row * 362, 362, 362, "legacy idle")), 0, row * FRAME_SIZE);
    for (let col = 0; col < 4; col += 1) layer.blit(frames[row * 4 + col], (col + 2) * FRAME_SIZE, row * FRAME_SIZE);
    const merged = composite(canvas, layer);
    merged.data.copy(canvas.data);
  }
  return canvas;
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check") || args.length > 1) {
  throw new Error("Usage: node tools/prepare-master-avatar.mjs [--check]");
}
const { atlas, frames, colors } = compile(JSON.parse(readFileSync(SOURCE, "utf8")));
const contact = comparison(frames);
const files = new Map([
  ["assets/sprites/master-adventurer.png", encodePng(atlas)],
  ["docs/art/master-adventurer-atlas-1x.png", encodePng(composite(checker(atlas.width, atlas.height), atlas))],
  ["docs/art/master-adventurer-atlas-4x.png", encodePng(upscale(composite(checker(atlas.width, atlas.height), atlas), 4))],
  ["docs/art/master-adventurer-comparison-1x.png", encodePng(contact)],
  ["docs/art/master-adventurer-comparison-4x.png", encodePng(upscale(contact, 4))],
]);
for (const [relative, bytes] of files) {
  const path = resolve(ROOT, relative);
  if (args.includes("--check")) {
    if (!readFileSync(path).equals(bytes)) throw new Error(`${relative} differs from its native source`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  console.log(`${args.includes("--check") ? "verified" : "wrote"} ${relative} sha256=${digest(bytes)}`);
}
console.log(`master avatar: 16 unique 48px frames, ${colors} opaque palette colors, foot (${FOOT.join(", ")}), hard alpha, no detached pixels`);
