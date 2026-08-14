import { expect, test } from "vitest";
import { loadSprite, mouthLuma } from "./decodePng";
import { ALL_SPRITES, LADDER, FRAME_KEYS, spriteOf } from "../lib/mouthFrames";

/**
 * The ladders are data about the pixels, so they are checked against the pixels.
 *
 * The order a frame opens in is not obvious from the file name, and — this is the
 * part the previous version missed — it is not obvious from a measurement either.
 * "How far open" depends on where you put the threshold: area darker than the
 * closed mouth by 25 says all eight visemes ramp cleanly, by 40 says four of them
 * do not. The sprite builder sorted by one of those thresholds and the old test
 * checked the same one, so the pair could only ever agree with itself.
 *
 * These tests therefore ask a weaker question that is actually answerable: does the
 * shipped order agree with the CONSENSUS of several ways of measuring, and is every
 * rung far enough from its neighbour to be worth a frame swap.
 */

const METRIC_THRESHOLDS = [10, 20, 25, 30, 40, 50];

const luma = new Map<string, Float64Array>();
for (const key of Object.keys(ALL_SPRITES)) {
  luma.set(key, mouthLuma(loadSprite(spriteOf(key))));
}
const rest = luma.get("rest")!;

/** Share of the mouth region darker than the closed mouth by `t`. */
function darkerThan(key: string, t: number): number {
  const a = luma.get(key)!;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (rest[i] - a[i] > t) n++;
  return n / a.length;
}

/** Mean absolute difference between two frames over the mouth region. */
function distance(a: string, b: string): number {
  const x = luma.get(a)!;
  const y = luma.get(b)!;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

/** A frame's average rank across every metric — its openness, agreed rather than asserted. */
function consensusOpenness(key: string): number {
  const keys = [...luma.keys()];
  let total = 0;
  for (const t of METRIC_THRESHOLDS) {
    const order = [...keys].sort((a, b) => darkerThan(a, t) - darkerThan(b, t));
    total += order.indexOf(key) / (keys.length - 1);
  }
  return total / METRIC_THRESHOLDS.length;
}

test("every rung of every ladder is a frame that exists", () => {
  for (const key of FRAME_KEYS) {
    expect(() => spriteOf(key), key).not.toThrow();
    expect(luma.get(key), `${key} did not decode`).toBeTruthy();
  }
});

test("rungs are ordered by how far open they measure, not by file name", () => {
  // Names run quarter, half, full. Measured, four of the eight visemes do not, and
  // showing them in name order plays "open, half shut, open" inside one sound.
  for (const [shape, rungs] of Object.entries(LADDER)) {
    const measured = rungs.map(consensusOpenness);
    for (let i = 1; i < measured.length; i++) {
      expect(
        measured[i],
        `${shape}: ${rungs[i]} (${measured[i].toFixed(3)}) is not wider than ` +
          `${rungs[i - 1]} (${measured[i - 1].toFixed(3)})`,
      ).toBeGreaterThan(measured[i - 1]);
    }
  }
});

test("no rung is too close to its neighbour to be worth showing", () => {
  // A step the eye cannot see costs a frame swap and shows nothing. The floor is
  // the 5th percentile of every pairwise distance in the set — below that, two
  // frames are the same picture.
  const keys = [...luma.keys()];
  const all: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) all.push(distance(keys[i], keys[j]));
  }
  all.sort((a, b) => a - b);
  const floor = all[Math.floor(all.length * 0.05)];

  for (const [shape, rungs] of Object.entries(LADDER)) {
    for (let i = 1; i < rungs.length; i++) {
      expect(
        distance(rungs[i - 1], rungs[i]),
        `${shape}: ${rungs[i - 1]} and ${rungs[i]} are the same picture`,
      ).toBeGreaterThanOrEqual(floor);
    }
  }
});

test("the shapes the mouth can select are distinguishable from each other", () => {
  // Eight visemes were drawn; the pixels tell five of them apart. Selecting a shape
  // whose widest frame matches another's spends a swap on a change nobody sees.
  const widest = Object.values(LADDER).map((rungs) => rungs[rungs.length - 1]);
  for (let i = 0; i < widest.length; i++) {
    for (let j = i + 1; j < widest.length; j++) {
      expect(
        distance(widest[i], widest[j]),
        `${widest[i]} and ${widest[j]} draw the same mouth`,
      ).toBeGreaterThan(5);
    }
  }
});
