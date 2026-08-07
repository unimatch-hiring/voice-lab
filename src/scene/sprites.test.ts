import { expect, test } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { MOUTH_SPRITES, HALF_SPRITES, QUARTER_SPRITES } from "./Mouth";

/**
 * Tests over the sprites themselves, not over the opacity numbers the component
 * writes out.
 *
 * The previous version checked only amplitude and shape hold — and stayed fully
 * green on an animation that looked like mush: the intermediate frames turned out
 * to be an alpha blend of "shut" + "open", i.e. a double exposure with ghost
 * teeth. Smooth numbers, broken picture. Here we measure pixels, so that exact
 * defect cannot pass.
 */

const FACE_DIR = `${process.cwd()}/public/`;

interface Bitmap {
  width: number;
  height: number;
  /** Per-pixel luminance, row by row. */
  luma: Float64Array;
}

/**
 * Minimal PNG decoder: only what the test needs. We did not pull in a package —
 * the repo rule is "zero new dependencies", and the sprites are written by our own
 * generator in a predictable form (8 bit, palette or RGB, a single IDAT stream).
 */
function decodePng(buf: Buffer): Bitmap {
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

function load(rel: string): Bitmap {
  const path = FACE_DIR + rel;
  if (!existsSync(path)) throw new Error(`missing sprite: ${rel}`);
  return decodePng(readFileSync(path));
}

/** Luminance inside the mouth region (frame fractions — same box as the generator). */
function mouthLuma(bmp: Bitmap): Float64Array {
  const x0 = Math.round(0.36 * bmp.width);
  const x1 = Math.round(0.64 * bmp.width);
  const y0 = Math.round(0.46 * bmp.height);
  const y1 = Math.round(0.62 * bmp.height);
  const out = new Float64Array((x1 - x0) * (y1 - y0));
  let i = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) out[i++] = bmp.luma[y * bmp.width + x];
  }
  return out;
}

/** Sharpness: mean luminance step between horizontal neighbours. */
function sharpness(luma: Float64Array, width: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < luma.length; i++) {
    if (i % width === 0) continue;
    sum += Math.abs(luma[i] - luma[i - 1]);
    n++;
  }
  return sum / n;
}

const MOUTH_W = () => {
  const bmp = load(MOUTH_SPRITES.rest);
  return Math.round(0.64 * bmp.width) - Math.round(0.36 * bmp.width);
};

test("every mouth frame exists on disk", () => {
  for (const rel of [
    ...Object.values(MOUTH_SPRITES),
    ...Object.values(HALF_SPRITES),
    ...Object.values(QUARTER_SPRITES),
  ]) {
    expect(() => load(rel), rel).not.toThrow();
  }
});

test("outside the mouth region frames are identical — only the mouth changes", () => {
  // Otherwise the whole character flickers on a viseme change: fur, suit, background.
  const rest = load(MOUTH_SPRITES.rest);
  // Truncate the bounds like the sprite builder does (Python int()) instead of
  // rounding: otherwise a one-pixel rim of the mouth region itself lands in the
  // background check.
  const x0 = Math.trunc(0.34 * rest.width);
  const x1 = Math.trunc(0.64 * rest.width);
  const y0 = Math.trunc(0.455 * rest.height);
  const y1 = Math.trunc(0.615 * rest.height);

  for (const [name, rel] of Object.entries(MOUTH_SPRITES)) {
    if (name === "rest") continue;
    const bmp = load(rel);
    let worst = 0;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
        const i = y * bmp.width + x;
        worst = Math.max(worst, Math.abs(bmp.luma[i] - rest.luma[i]));
      }
    }
    expect(worst, `${name}: background differs from rest`).toBeLessThanOrEqual(8);
  }
});

test("an intermediate frame is a real pose, not a blend of shut and open", () => {
  // The defect in question: half = (rest + full) / 2 gave a semi-transparent
  // overlay of two mouths. Such a blend is almost exactly the mean, so we catch it
  // by distance to the mean: a real pose does not sit that close to it.
  const width = MOUTH_W();
  for (const key of Object.keys(HALF_SPRITES) as Array<keyof typeof HALF_SPRITES>) {
    const rest = mouthLuma(load(MOUTH_SPRITES.rest));
    const full = mouthLuma(load(MOUTH_SPRITES[key]));
    const half = mouthLuma(load(HALF_SPRITES[key]));

    let dist = 0;
    for (let i = 0; i < half.length; i++) {
      dist += Math.abs(half[i] - (rest[i] + full[i]) / 2);
    }
    dist /= half.length;
    expect(dist, `${key}h looks too much like an alpha blend of rest+full`).toBeGreaterThan(4);

    // And it must not be softer than either: blur is a direct sign of overlay.
    const sHalf = sharpness(half, width);
    const sRest = sharpness(rest, width);
    expect(sHalf, `${key}h is blurrier than the closed mouth`).toBeGreaterThan(sRest * 0.85);
  }
});

test("an intermediate frame is not opened wider than the shape itself", () => {
  // The oral cavity is darker than the muzzle, so "how much darker than rest" is a
  // direct measure of how far the mouth is open.
  //
  // We cannot demand strict `half < full`: for stops and low-amplitude visemes
  // (MBP, WQ, FV, U, E) the halfway pose nearly coincides with the shape itself, and
  // the generator legitimately returns them equal. We catch only the real breakage —
  // when the intermediate frame is NOTICEABLY wider than the final one, i.e. the
  // mouth flings open and then slams shut within the same viseme.
  const rest = mouthLuma(load(MOUTH_SPRITES.rest));
  const openness = (luma: Float64Array) => {
    let n = 0;
    for (let i = 0; i < luma.length; i++) if (rest[i] - luma[i] > 25) n++;
    return n / luma.length;
  };

  for (const key of Object.keys(HALF_SPRITES) as Array<keyof typeof HALF_SPRITES>) {
    const half = openness(mouthLuma(load(HALF_SPRITES[key])));
    const full = openness(mouthLuma(load(MOUTH_SPRITES[key])));
    expect(half, `${key}h should be partly open`).toBeGreaterThan(0.01);
    expect(half, `${key}h is opened wider than ${key}`).toBeLessThan(full * 1.15);
  }
});

test("phases of one viseme open in strictly increasing order", () => {
  // The generator does not always hit the requested amplitude: for the stops /m/, /f/
  // the "quarter" comes out wider than the "half". The sprite builder reorders phases
  // by what they actually measure, and that order must hold — otherwise on such a
  // viseme the mouth first opens wider and then slams shut mid-sound.
  const rest = mouthLuma(load(MOUTH_SPRITES.rest));
  const openness = (luma: Float64Array) => {
    let n = 0;
    for (let i = 0; i < luma.length; i++) if (rest[i] - luma[i] > 25) n++;
    return n / luma.length;
  };

  for (const key of Object.keys(HALF_SPRITES) as Array<keyof typeof HALF_SPRITES>) {
    const q = openness(mouthLuma(load(QUARTER_SPRITES[key])));
    const h = openness(mouthLuma(load(HALF_SPRITES[key])));
    const full = openness(mouthLuma(load(MOUTH_SPRITES[key])));
    expect(q, `${key}: quarter is wider than half (${q.toFixed(4)} > ${h.toFixed(4)})`)
      .toBeLessThanOrEqual(h);
    expect(h, `${key}: half is wider than the full shape (${h.toFixed(4)} > ${full.toFixed(4)})`)
      .toBeLessThanOrEqual(full);
  }
});
