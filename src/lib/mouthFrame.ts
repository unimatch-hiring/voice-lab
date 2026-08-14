import { LADDER, rungsOf, type FrameKey, type Shape } from "./mouthFrames";

/**
 * Picks the one frame to show, and when to change it.
 *
 * Separate from the component on purpose: everything that decides how the mouth
 * moves is a pure step over numbers, so it can be driven by a recording in a test
 * instead of by talking to the agent and trusting the memory of the last run.
 *
 * The animation is a hard cut between opaque frames. The previous version
 * cross-faded neighbouring sprites by opacity, which on photographs is a double
 * exposure — half-transparent teeth over a closed muzzle, with the closed frame
 * left underneath at full opacity as a backdrop, so an open mouth was never
 * actually opaque. That is what "blurry" was, and it cannot be tuned out: with
 * `source-over` the backdrop always shows through by the product of what is above
 * it. Only one frame being visible fixes it by construction.
 */

/**
 * Level at which the mouth reaches its widest rung. Speech runs a median of 0.35
 * and a 90th percentile of 0.48 on the recorded fixtures, so the top rung is
 * reachable but not the normal state. The previous gain saturated at 0.33, which
 * put more than half of all frames at "open as far as it goes" — the amplitude was
 * carrying no information at all.
 */
export const LEVEL_FULL = 0.5;

/**
 * Below this the mouth is shut.
 *
 * Chosen against the fixtures rather than by ear. It leaves the mouth closed for
 * 22 / 26 / 52% of the three recordings, whose written pauses are 29 / 34 / 56% —
 * tracking them with a small deficit, which is right: a reverb tail is not silence.
 * The old 0.02 sat below room tone, which is how the raccoon came to hold its mouth
 * open through every gap between words.
 */
export const LEVEL_FLOOR = 0.1;

/**
 * Minimum time a frame stays on screen. Traditional 2D animation holds drawings
 * for two or three frames of 24; this is the same idea at ~14 changes a second,
 * which is about the rate speech articulates at. The previous 150 ms let through
 * only a third of them.
 */
export const MIN_FRAME_MS = 70;

/** How fast the mouth shuts when nothing is playing, in rungs per second. */
const CLOSE_RUNGS_PER_S = 12;

export interface MouthState {
  shape: Shape;
  rung: number;
  /** Time the current frame has been on screen. */
  heldMs: number;
}

export const INITIAL: MouthState = { shape: "MBP", rung: 0, heldMs: 0 };

/**
 * Which rung of this shape a level asks for.
 *
 * Quietly audible maps to rung 0 — shut — and not to "at least a little open". The
 * floor of one rung seemed right (sound means a moving mouth) and was the last
 * sticking left: on the decaying tail of a phrase the level hangs just above
 * LEVEL_FLOOR for half a second, and forcing a rung there froze the mouth ajar for
 * 400–500 ms at a stretch. Measured on the bench, that was the longest hold in a
 * whole sentence.
 */
function rungFor(level: number, shape: Shape): number {
  const t = (level - LEVEL_FLOOR) / (LEVEL_FULL - LEVEL_FLOOR);
  if (t <= 0) return 0;
  return Math.round(Math.min(1, t) * rungsOf(shape));
}

/**
 * One animation step.
 *
 * `level` of `null` means there is no sound to read — the session ended, the
 * connection died, or the SDK is handing back a spectrum frozen at the last thing
 * it played. It is not the same as "quiet": quiet is a measurement, null is the
 * absence of one, and both have to shut the mouth. A mouth left open because the
 * data stopped arriving is the defect this returns to.
 */
export function step(
  state: MouthState,
  level: number | null,
  shape: Shape,
  dtMs: number,
): MouthState {
  const held = state.heldMs + dtMs;

  // Closing is never held back and never asymptotic: an exponential approach to
  // zero is always a little open, and "a little open" is what stays on screen.
  if (level === null) {
    const step = (CLOSE_RUNGS_PER_S * dtMs) / 1000;
    const rung = Math.max(0, state.rung - Math.max(step, state.rung > 0 ? 0.05 : 0));
    return { shape: state.shape, rung: rung < 0.05 ? 0 : rung, heldMs: held };
  }

  if (held < MIN_FRAME_MS) return { ...state, heldMs: held };

  const wanted = rungFor(level, shape);

  // The rung goes straight where the loudness asks, including across a change of
  // shape. Two rules were tried here and both made it worse. Stepping one rung at a
  // time quartered the articulation rate for nothing: these frames are not
  // in-betweens of a motion, they are separate poses, and 2D lip sync cuts to the
  // drawing a sound needs rather than easing into it. Refusing to open wider on a
  // step that also changes shape looked reasonable and locked the mouth shut — from
  // rest the cap is zero, so while the classifier was still picking a shape the
  // mouth could never leave the closed frame, however loud the audio got.
  const rung = wanted;

  const settled = rung === state.rung && shape === state.shape;
  return { shape, rung, heldMs: settled ? held : 0 };
}

/** The sprite this state shows. Fractional rungs round down: never wider than asked. */
export function frameOf(state: MouthState): FrameKey {
  const rungs = LADDER[state.shape];
  const i = Math.max(0, Math.min(rungs.length - 1, Math.floor(state.rung)));
  return rungs[i];
}
