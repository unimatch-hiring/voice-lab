import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * Reads the character's sprites as pixels, for the tests that measure them.
 *
 * Node-only and never imported by the app, so it does not ship. It lives here
 * rather than inside one test file because two of them measure the same frames and
 * must agree on what they are looking at.
 *
 * Minimal on purpose: 8 bit, palette or RGB, a single IDAT stream — which is what
 * our own generator writes. Pulling in a decoder would be a dependency, and the
 * repo has none.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** Per-pixel luminance, row by row. */
  luma: Float64Array;
}

export function decodePng(buf: Buffer): Bitmap {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colorType = buf[25];
  if (depth !== 8) throw new Error(`expected 8 bits per channel, got ${depth}`);

  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IDAT") idat.push(body);
    else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }

  const channels = colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const luma = new Float64Array(width * height);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    raw.copy(line, 0, src, src + stride);
    src += stride;
    // Undo the PNG per-scanline filters (spec 9.2).
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      let r: number;
      let g: number;
      let bl: number;
      if (colorType === 3) {
        const idx = line[x] * 3;
        r = palette![idx];
        g = palette![idx + 1];
        bl = palette![idx + 2];
      } else {
        const p = x * channels;
        r = line[p];
        g = line[p + 1];
        bl = line[p + 2];
      }
      luma[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * bl;
    }
  }
  return { width, height, luma };
}

const FACE_DIR = `${process.cwd()}/public/`;

export function loadSprite(rel: string): Bitmap {
  const path = FACE_DIR + rel;
  if (!existsSync(path)) throw new Error(`missing sprite: ${rel}`);
  return decodePng(readFileSync(path));
}

/**
 * Luminance inside the mouth region. The bounds are the generator's, truncated the
 * way Python's `int()` does rather than rounded — rounding puts a one-pixel rim of
 * the mouth itself into what the background check treats as background.
 */
export function mouthLuma(bmp: Bitmap): Float64Array {
  const x0 = Math.trunc(0.34 * bmp.width);
  const x1 = Math.trunc(0.64 * bmp.width);
  const y0 = Math.trunc(0.455 * bmp.height);
  const y1 = Math.trunc(0.615 * bmp.height);
  const out = new Float64Array((x1 - x0) * (y1 - y0));
  let i = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) out[i++] = bmp.luma[y * bmp.width + x];
  }
  return out;
}
