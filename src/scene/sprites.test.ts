import { expect, test } from "vitest";
import { loadSprite, mouthLuma, type Bitmap } from "./decodePng";
import { MOUTH_SPRITES, HALF_SPRITES, QUARTER_SPRITES } from "../lib/mouthFrames";

/**
 * Tests over the sprites themselves, not over the numbers the component writes out.
 *
 * An earlier suite checked only amplitude and shape hold, and stayed green on an
 * animation that looked like mush: the intermediate frames were an alpha blend of
 * "shut" and "open", a double exposure with ghost teeth. Smooth numbers, broken
 * picture. Here we measure pixels, so that defect cannot pass.
 *
 * Phase ORDER is not tested here any more. It is metric-dependent, and the
 * threshold this file used to pick was the one the sprite builder sorted by, so the
 * test could only ever agree with itself. `mouthFrames.test.ts` checks the shipped
 * order against a consensus of several metrics instead.
 */

const MOUTH_WIDTH = (bmp: Bitmap) =>
  Math.trunc(0.64 * bmp.width) - Math.trunc(0.34 * bmp.width);

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

test("every mouth frame exists on disk", () => {
  for (const rel of [
    ...Object.values(MOUTH_SPRITES),
    ...Object.values(HALF_SPRITES),
    ...Object.values(QUARTER_SPRITES),
  ]) {
    expect(() => loadSprite(rel), rel).not.toThrow();
  }
});

test("outside the mouth region frames are identical — only the mouth changes", () => {
  // Otherwise the whole character flickers on a viseme change: fur, suit, background.
  // It is also what makes a hard cut safe: a swap moves about 4% of the frame, and
  // the nose and eyes above it do not move at all.
  const rest = loadSprite(MOUTH_SPRITES.rest);
  const x0 = Math.trunc(0.34 * rest.width);
  const x1 = Math.trunc(0.64 * rest.width);
  const y0 = Math.trunc(0.455 * rest.height);
  const y1 = Math.trunc(0.615 * rest.height);

  for (const [name, rel] of Object.entries(MOUTH_SPRITES)) {
    if (name === "rest") continue;
    const bmp = loadSprite(rel);
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
  // The defect in question: half = (rest + full) / 2 gives a semi-transparent
  // overlay of two mouths. Such a blend is almost exactly the mean, so we catch it
  // by distance to the mean — a real pose does not sit that close to it.
  const restBmp = loadSprite(MOUTH_SPRITES.rest);
  const rest = mouthLuma(restBmp);
  const width = MOUTH_WIDTH(restBmp);

  for (const key of Object.keys(HALF_SPRITES) as Array<keyof typeof HALF_SPRITES>) {
    const full = mouthLuma(loadSprite(MOUTH_SPRITES[key]));
    const half = mouthLuma(loadSprite(HALF_SPRITES[key]));

    let dist = 0;
    for (let i = 0; i < half.length; i++) {
      dist += Math.abs(half[i] - (rest[i] + full[i]) / 2);
    }
    dist /= half.length;
    expect(dist, `${key}h looks too much like an alpha blend of rest+full`).toBeGreaterThan(4);

    // And it must not be softer than either: blur is a direct sign of overlay.
    expect(
      sharpness(half, width),
      `${key}h is blurrier than the closed mouth`,
    ).toBeGreaterThan(sharpness(rest, width) * 0.85);
  }
});

test("an intermediate frame is not opened wider than the shape itself", () => {
  // The oral cavity is darker than the muzzle, so "how much darker than rest" is one
  // measure of how far the mouth is open. Not a strict `half < full`: for stops and
  // low-amplitude visemes the halfway pose legitimately coincides with the shape.
  // We catch only the gross breakage — an intermediate frame NOTICEABLY wider than
  // the final one, i.e. the mouth flung open and slammed shut inside one sound.
  const rest = mouthLuma(loadSprite(MOUTH_SPRITES.rest));
  const openness = (luma: Float64Array) => {
    let n = 0;
    for (let i = 0; i < luma.length; i++) if (rest[i] - luma[i] > 25) n++;
    return n / luma.length;
  };

  for (const key of Object.keys(HALF_SPRITES) as Array<keyof typeof HALF_SPRITES>) {
    const half = openness(mouthLuma(loadSprite(HALF_SPRITES[key])));
    const full = openness(mouthLuma(loadSprite(MOUTH_SPRITES[key])));
    expect(half, `${key}h should be partly open`).toBeGreaterThan(0.01);
    expect(half, `${key}h is opened wider than ${key}`).toBeLessThan(full * 1.15);
  }
});
