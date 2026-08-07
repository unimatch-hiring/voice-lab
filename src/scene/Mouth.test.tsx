import { expect, test } from "vitest";
import { render } from "@testing-library/react";
import { Mouth, MOUTH_SPRITES } from "./Mouth";
import { VisemeTimeline } from "../lib/visemes";
import type { Viseme } from "../lib/visemes";

const VISEMES: Viseme[] = ["rest", "MBP", "AI", "E", "O", "U", "FV", "L", "WQ"];

test("ships a sprite for every viseme", () => {
  for (const v of VISEMES) {
    expect(MOUTH_SPRITES[v], `no sprite for ${v}`).toBeTruthy();
    expect(MOUTH_SPRITES[v].endsWith(".png")).toBe(true);
  }
});

test("every viseme maps to its own file", () => {
  const files = VISEMES.map((v) => MOUTH_SPRITES[v]);
  expect(new Set(files).size).toBe(VISEMES.length);
});

/** Viseme of the phrase's first character — used to check the starting frame. */
function timelineOf(chars: string[], durMs = 100): VisemeTimeline {
  const t = new VisemeTimeline();
  t.append({
    audio: new Int16Array(0),
    chars,
    charStartTimesMs: chars.map((_, i) => i * durMs),
    charDurationsMs: chars.map(() => durMs),
  });
  return t;
}

/**
 * Which mouth shape is showing right now, and how far it is open (0..1).
 *
 * Openness is spread across four frames (rest -> q -> h -> full) with a constant
 * opacity sum: exactly two phase neighbours are visible. So we recover the
 * amplitude as the position between those neighbours on the phase scale, not as
 * the opacity sum — that sum would always be one.
 */
const PHASE_LEVEL: Record<string, number> = { rest: 0, q: 1 / 3, h: 2 / 3, full: 1 };

function readMouth(container: HTMLElement) {
  const lit = ([...container.querySelectorAll("img")] as HTMLImageElement[])
    .map((el) => {
      const file = el.getAttribute("src")!.split("/").pop()!.replace(".png", "");
      const suffix = file === "rest" ? "rest" : /[qh]$/.test(file) ? file.slice(-1) : "full";
      return {
        name: file,
        shape: file.replace(/[qh]$/, ""),
        level: PHASE_LEVEL[suffix],
        opacity: Number(el.style.opacity),
      };
    })
    .filter((f) => f.name !== "rest" && f.opacity > 0.01);

  // Weighted position on the phase scale: the weights sum to one, so this is
  // exactly the openness the eye sees.
  const openness = lit.reduce((sum, f) => sum + f.level * f.opacity, 0);
  const shape = lit.length
    ? lit.reduce((a, b) => (b.opacity > a.opacity ? b : a)).shape
    : "rest";
  return { shape, openness };
}

test("mouth follows the audio playhead, not a wall clock", () => {
  const timeline = timelineOf(["м", "а"]);
  // Playhead parked: audio is not playing.
  const playback = { elapsedMs: 0, isPlaying: false, enqueue: () => {}, stop: () => {} };

  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;

  try {
    const { container } = render(
      <Mouth timeline={timeline} playback={playback as never} />,
    );

    // Frames tick along with varying timestamps, the playhead does not move — the shape holds.
    for (let i = 0; i < 60; i++) frames.splice(0).forEach((cb) => cb(i * 16));
    expect(readMouth(container).shape).toBe("MBP");
    const held = readMouth(container).openness;
    for (let i = 0; i < 20; i++) frames.splice(0).forEach((cb) => cb(1000 + i * 16));
    expect(
      readMouth(container).openness,
      "playhead parked — the mouth does not move",
    ).toBeCloseTo(held, 1);

    // Move ONLY the playhead — the shape must travel to the next viseme.
    playback.elapsedMs = 150;
    for (let i = 0; i < 20; i++) frames.splice(0).forEach((cb) => cb(2000 + i * 16));
    expect(readMouth(container).shape).toBe("AI");
    expect(MOUTH_SPRITES.AI).toBeTruthy();
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});

test("the mouth travels into a shape instead of snapping to it", () => {
  // The sprites were drawn wide open, so a discrete frame swap is always a jump
  // in amplitude — that is what read as jitter. Openness must build up
  // gradually, over several animation frames.
  // A long viseme on purpose: with ~200 ms of smoothing a short syllable legitimately
  // never reaches full opening, so measuring amplitude on one would be unfair.
  const timeline = timelineOf(["а"], 800);
  const playback = { elapsedMs: 0, isPlaying: true, enqueue: () => {}, stop: () => {} };

  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;

  try {
    const { container } = render(
      <Mouth timeline={timeline} playback={playback as never} />,
    );

    const seen: number[] = [];
    // 60 frames ~ 1 s: with ~200 ms to target the mouth has time to get there.
    for (let i = 0; i < 60; i++) {
      playback.elapsedMs = i * 16;
      frames.splice(0).forEach((cb) => cb(playback.elapsedMs));
      seen.push(readMouth(container).openness);
    }

    expect(seen[0], "on the first frame the mouth is still nearly shut").toBeLessThan(0.25);
    expect(Math.max(...seen), "by the end of the viseme the mouth is open").toBeGreaterThan(
      0.5,
    );

    let maxJump = 0;
    for (let i = 1; i < seen.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(seen[i] - seen[i - 1]));
    }
    // A "shut → wide open" step would produce a jump of about 1.0.
    expect(maxJump, "amplitude changes smoothly, with no step").toBeLessThan(0.3);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});

test("a shape holds long enough to be seen", () => {
  // Standard 2D lip-sync practice: frame-holding. Without it the shape changes
  // faster than the eye reads as speech, and the mouth jitters.
  const timeline = timelineOf(["м", "а", "о", "у", "и"], 40);
  const playback = { elapsedMs: 0, isPlaying: true, enqueue: () => {}, stop: () => {} };

  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;

  try {
    const { container } = render(
      <Mouth timeline={timeline} playback={playback as never} />,
    );

    const shapes: string[] = [];
    for (let i = 0; i < 40; i++) {
      playback.elapsedMs = Math.round(i * 16.7);
      frames.splice(0).forEach((cb) => cb(playback.elapsedMs));
      shapes.push(readMouth(container).shape);
    }

    // Count runs of consecutive identical shapes.
    const lengths: number[] = [];
    for (let i = 0; i < shapes.length; i++) {
      if (i === 0 || shapes[i] !== shapes[i - 1]) lengths.push(1);
      else lengths[lengths.length - 1]++;
    }
    const flicker = lengths.filter((n) => n === 1).length;
    expect(flicker, `shapes that flashed for a single frame: ${flicker}`).toBeLessThanOrEqual(
      1,
    );
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});
