import { expect, test } from "vitest";
import { frameOf, step, INITIAL, LEVEL_FLOOR, LEVEL_FULL, MIN_FRAME_MS } from "./mouthFrame";
import type { MouthState } from "./mouthFrame";
import { LADDER } from "./mouthFrames";

/** Runs the machine over a constant input, the way the animation loop would. */
function run(
  level: number | null,
  shape: Parameters<typeof step>[2],
  ms: number,
  from: MouthState = INITIAL,
): MouthState {
  let state = from;
  for (let t = 0; t < ms; t += 16.7) state = step(state, level, shape, 16.7);
  return state;
}

test("no signal shuts the mouth, and keeps it shut", () => {
  // The defect this exists for: the mouth left open because measurements stopped
  // arriving. Null is not quiet — it is the absence of a reading — and both close.
  const open = run(LEVEL_FULL, "AI", 500);
  expect(frameOf(open)).not.toBe("rest");

  const after = run(null, "AI", 400, open);
  expect(frameOf(after), "no signal — shut").toBe("rest");
  expect(run(null, "AI", 2000, after).rung).toBe(0);
});

test("silence shuts the mouth even while the signal keeps arriving", () => {
  const open = run(LEVEL_FULL, "AI", 500);
  expect(frameOf(run(LEVEL_FLOOR / 2, "AI", 400, open))).toBe("rest");
});

test("the mouth closes within a third of a second", () => {
  // Slower than this and the end of a reply is visibly a mouth left hanging.
  const open = run(LEVEL_FULL, "AI", 500);
  expect(frameOf(run(null, "AI", 330, open))).toBe("rest");
});

test("a louder sound opens the mouth wider", () => {
  const quiet = run(LEVEL_FLOOR + 0.02, "AI", 400);
  const loud = run(LEVEL_FULL, "AI", 400);
  const rungs = LADDER.AI;
  expect(rungs.indexOf(frameOf(loud))).toBeGreaterThan(rungs.indexOf(frameOf(quiet)));
});

test("a frame stays on screen long enough to be read", () => {
  // Frame holding, the oldest rule in 2D lip sync. Without it the picture changes
  // faster than the eye resolves and reads as flicker rather than speech.
  let state = INITIAL;
  let shown = frameOf(state);
  let sinceChange = 0;
  let worst = Infinity;

  const script: Array<[number, Parameters<typeof step>[2]]> = [
    [0.5, "AI"], [0.2, "MBP"], [0.45, "O"], [0.15, "L"], [0.5, "FV"],
  ];

  for (let i = 0; i < 600; i++) {
    const [level, shape] = script[i % script.length];
    state = step(state, level, shape, 16.7);
    sinceChange += 16.7;
    const next = frameOf(state);
    if (next !== shown) {
      worst = Math.min(worst, sinceChange);
      sinceChange = 0;
      shown = next;
    }
  }

  expect(worst).toBeGreaterThanOrEqual(MIN_FRAME_MS);
});

test("a frozen input settles instead of oscillating", () => {
  const a = run(0.4, "O", 800);
  const b = step(a, 0.4, "O", 16.7);
  expect(frameOf(b)).toBe(frameOf(a));
});

test("every rung of every ladder is a real sprite", () => {
  for (const [shape, rungs] of Object.entries(LADDER)) {
    for (let i = 0; i < rungs.length; i++) {
      expect(frameOf({ shape: shape as never, rung: i, heldMs: 0 })).toBe(rungs[i]);
    }
  }
});
