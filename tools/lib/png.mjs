// Pure image primitives shared by the asset importers (tools/import-ninja-assets.mjs for the
// tileset, tools/import-avatar.mjs for the character sheet): a dependency-free PNG codec, an
// RGBA canvas, and the crop/scale/blend helpers the recipes are written in.
//
// Nothing here touches the filesystem or process state — every function is deterministic and
// side-effect free, so running an importer twice always produces identical bytes.
import { deflateSync, inflateSync } from "node:zlib";

/**
 * Grid constants, not codec constants, but shared: every source pack we import is 16px native
 * pixel art and every one of our tiles/frames is 32px, so both importers scale by exactly 2 with
 * nearest-neighbour. They live here because `cell`/`pad`/`tileRows` are defined on the 16px grid.
 * TILE must stay equal to TILE_SIZE_PX in shared/src/constants.ts.
 */
export const SRC_TILE = 16;
export const TILE = 32;
export const SCALE = TILE / SRC_TILE;

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

export function encodePng(canvas) {
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses the per-scanline PNG filters (spec 9.2) for 8-bit RGBA, i.e. 4 bytes per pixel. */
function unfilter(raw, width, height, label) {
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) {
    throw new Error(`${label}: inflated to ${raw.length} bytes, expected ${(stride + 1) * height}`);
  }
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const from = y * (stride + 1);
    const filter = raw[from];
    const row = y * stride;
    const prior = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? out[row + x - bpp] : 0;
      const up = y > 0 ? out[prior + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[prior + x - bpp] : 0;
      const value = raw[from + 1 + x];
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`${label}: unsupported filter type ${filter} on row ${y}`);
      }
      out[row + x] = restored & 0xff;
    }
  }
  return out;
}

export function decodePng(buffer, label) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label}: not a PNG file`);
  }
  let header = null;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === "IDAT") {
      // Encoders split the pixel stream across several IDATs; only their concatenation inflates.
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error(`${label}: no IHDR chunk`);
  if (idat.length === 0) throw new Error(`${label}: no IDAT chunk`);
  if (header.bitDepth !== 8 || header.colorType !== 6) {
    throw new Error(
      `${label}: expected bitdepth 8 / colortype 6 (RGBA), got ${header.bitDepth}/${header.colorType}`,
    );
  }
  if (header.interlace !== 0) throw new Error(`${label}: interlaced PNGs are not supported`);
  if (header.compression !== 0 || header.filter !== 0) {
    throw new Error(`${label}: unsupported compression/filter method`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  return new Canvas(header.width, header.height, unfilter(raw, header.width, header.height, label));
}

/* ------------------------------------------------------------- canvas ---- */

export class Canvas {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data ?? Buffer.alloc(width * height * 4);
  }

  at(x, y) {
    return (y * this.width + x) * 4;
  }

  /** Copies every channel, alpha included, so transparent padding stays transparent. */
  blit(source, x, y) {
    for (let dy = 0; dy < source.height; dy += 1) {
      source.data.copy(
        this.data,
        this.at(x, y + dy),
        source.at(0, dy),
        source.at(0, dy) + source.width * 4,
      );
    }
  }
}

export function crop(source, x, y, width, height, label) {
  if (x < 0 || y < 0 || x + width > source.width || y + height > source.height) {
    throw new Error(
      `${label}: crop ${width}x${height} at (${x},${y}) is outside the ${source.width}x${source.height} source`,
    );
  }
  const out = new Canvas(width, height);
  for (let dy = 0; dy < height; dy += 1) {
    source.data.copy(out.data, out.at(0, dy), source.at(x, y + dy), source.at(x + width, y + dy));
  }
  return out;
}

/** Crops one cell of the source's 16px grid; `col`/`row` are 0-indexed cell coordinates. */
export function cell(source, col, row) {
  return crop(source, col * SRC_TILE, row * SRC_TILE, SRC_TILE, SRC_TILE, source.label ?? "source");
}

/** Places an undersized prop on a transparent 16x16 cell at the given offset. */
export function pad(source, offsetX, offsetY) {
  if (source.width + offsetX > SRC_TILE || source.height + offsetY > SRC_TILE) {
    throw new Error(
      `${source.label ?? "source"}: ${source.width}x${source.height} at (${offsetX},${offsetY}) overflows a ${SRC_TILE}px cell`,
    );
  }
  const out = new Canvas(SRC_TILE, SRC_TILE);
  out.blit(source, offsetX, offsetY);
  return out;
}

/**
 * Repeats a horizontal slice of `source` down a whole cell. `height` must divide SRC_TILE so
 * the tile edge lands on a repeat boundary; the seam is then an adjacency the art already
 * contains, which is what lets one tile run in any direction.
 */
export function tileRows(source, y, height) {
  if (SRC_TILE % height !== 0) {
    throw new Error(`tileRows: ${height} does not divide the ${SRC_TILE}px cell`);
  }
  const strip = crop(source, 0, y, SRC_TILE, height, source.label ?? "source");
  const out = new Canvas(SRC_TILE, SRC_TILE);
  for (let dy = 0; dy < SRC_TILE; dy += height) out.blit(strip, 0, dy);
  return out;
}

/** Straight-alpha source-over: `over` is drawn on top of a copy of `base`. */
export function composite(base, over) {
  if (base.width !== over.width || base.height !== over.height) {
    throw new Error("composite: layers must have the same size");
  }
  const out = new Canvas(base.width, base.height, Buffer.from(base.data));
  for (let i = 0; i < out.data.length; i += 4) {
    const srcAlpha = over.data[i + 3];
    if (srcAlpha === 0) continue;
    if (srcAlpha === 255) {
      over.data.copy(out.data, i, i, i + 4);
      continue;
    }
    const src = srcAlpha / 255;
    const dst = (out.data[i + 3] / 255) * (1 - src);
    const alpha = src + dst;
    for (let c = 0; c < 3; c += 1) {
      out.data[i + c] = Math.round((over.data[i + c] * src + out.data[i + c] * dst) / alpha);
    }
    out.data[i + 3] = Math.round(alpha * 255);
  }
  return out;
}

/** Exact RGB substitution; alpha is never read or written, so anti-aliased edges survive. */
export function recolor(source, pairs) {
  const out = new Canvas(source.width, source.height, Buffer.from(source.data));
  let replaced = 0;
  for (let i = 0; i < out.data.length; i += 4) {
    for (const [from, to] of pairs) {
      if (out.data[i] === from[0] && out.data[i + 1] === from[1] && out.data[i + 2] === from[2]) {
        out.data[i] = to[0];
        out.data[i + 1] = to[1];
        out.data[i + 2] = to[2];
        replaced += 1;
        break;
      }
    }
  }
  if (replaced === 0) throw new Error("recolor: none of the source colours were found");
  return out;
}

/** Nearest-neighbour only — any interpolation would blur the pixel art. */
export function upscale(source, factor) {
  const out = new Canvas(source.width * factor, source.height * factor);
  for (let y = 0; y < out.height; y += 1) {
    const srcRow = Math.floor(y / factor);
    for (let x = 0; x < out.width; x += 1) {
      const from = source.at(Math.floor(x / factor), srcRow);
      source.data.copy(out.data, out.at(x, y), from, from + 4);
    }
  }
  return out;
}
