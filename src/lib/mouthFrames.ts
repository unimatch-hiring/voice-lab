/**
 * The character's mouth frames, and the order they open in.
 *
 * The order is measured, not assumed — but measuring it is not as simple as the
 * previous version believed. Openness of a photographic mouth depends on what you
 * count as "open": area darker than the closed mouth by 25 says all eight visemes
 * ramp cleanly, area darker by 40 says four of them do not, and cavity depth says
 * something else again. The sprite builder sorted by one of those thresholds, and
 * `sprites.test.ts` then checked the same one, so the pair agreed with itself.
 *
 * So the rungs below come from a consensus: each frame's rank averaged over eight
 * thresholds and cavity metrics. A rung the metrics cannot separate from the one
 * below it (5th percentile of all pairwise distances) is dropped rather than shown
 * — a step the eye cannot see is a frame that only costs a swap.
 *
 * Two consequences worth knowing before reading the rest of the mouth code:
 * adjacent phases of one shape differ by about as much as two different shapes do
 * (median 9.4 against 13.4), and the eight visemes collapse into five groups the
 * pixels can tell apart. The set draws five mouths, not twenty-four.
 *
 * `mouthFrames.test.ts` recomputes the consensus from the pixels and fails if this
 * table disagrees with it, so the data cannot drift away from the assets in silence.
 */

export type Shape = "MBP" | "FV" | "L" | "O" | "AI";
export type FrameKey = string;

/** Every viseme the generator drew, at its widest. `rest` is the closed mouth. */
export const MOUTH_SPRITES = {
  rest: "face/rest.png",
  MBP: "face/MBP.png",
  AI: "face/AI.png",
  E: "face/E.png",
  O: "face/O.png",
  U: "face/U.png",
  FV: "face/FV.png",
  L: "face/L.png",
  WQ: "face/WQ.png",
} as const;

/** Midway through the jaw's travel. */
export const HALF_SPRITES = {
  MBP: "face/MBPh.png",
  AI: "face/AIh.png",
  E: "face/Eh.png",
  O: "face/Oh.png",
  U: "face/Uh.png",
  FV: "face/FVh.png",
  L: "face/Lh.png",
  WQ: "face/WQh.png",
} as const;

/** The first third of the jaw's travel. */
export const QUARTER_SPRITES = {
  MBP: "face/MBPq.png",
  AI: "face/AIq.png",
  E: "face/Eq.png",
  O: "face/Oq.png",
  U: "face/Uq.png",
  FV: "face/FVq.png",
  L: "face/Lq.png",
  WQ: "face/WQq.png",
} as const;

/** Every frame on disk, including the ones the mouth never selects. */
export const ALL_SPRITES: Record<string, string> = {
  ...MOUTH_SPRITES,
  ...Object.fromEntries(Object.entries(HALF_SPRITES).map(([k, v]) => [`${k}h`, v])),
  ...Object.fromEntries(Object.entries(QUARTER_SPRITES).map(([k, v]) => [`${k}q`, v])),
};

/**
 * Rungs per shape, shut to widest. `rest` is the first rung of every ladder: the
 * mouth reaches silence through the same frames it opened through.
 *
 * Only five shapes are addressed at runtime. The other three draw the same picture
 * as one of these — MBP/U/WQ are within the noise of each other, and E is within
 * the noise of O — so selecting them would cost a frame swap and show nothing.
 */
export const LADDER: Record<Shape, readonly FrameKey[]> = {
  // The labial group. `Uh` and the full `WQ` are dropped: no metric separates them
  // from their neighbours.
  MBP: ["rest", "MBPq", "MBPh", "MBP"],
  FV: ["rest", "FVq", "FVh", "FV"],
  L: ["rest", "Lq", "Lh", "L"],
  // Rounded and front vowels share a cluster; `O` carries both.
  O: ["rest", "Oq", "Oh", "O"],
  AI: ["rest", "AIq", "AIh", "AI"],
};

export const SHAPES = Object.keys(LADDER) as Shape[];

/** Frames the renderer can show. One of them is opaque at any moment. */
export const FRAME_KEYS: readonly FrameKey[] = [
  ...new Set(Object.values(LADDER).flat()),
];

export function spriteOf(key: FrameKey): string {
  const file = ALL_SPRITES[key];
  if (!file) throw new Error(`no sprite for frame ${key}`);
  return file;
}

/** Rungs above `rest`, i.e. how many steps of opening this shape can show. */
export function rungsOf(shape: Shape): number {
  return LADDER[shape].length - 1;
}
