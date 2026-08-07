import { useEffect, useRef } from "react";
import type { Viseme, VisemeTimeline } from "../lib/visemes";
/** The mouth's clock: with Agents the SDK plays the audio, so this is not a queue. */
export interface PlaybackLike {
  readonly elapsedMs: number;
  readonly isPlaying: boolean;
}

const VISEMES: readonly Viseme[] = [
  "rest", "MBP", "AI", "E", "O", "U", "FV", "L", "WQ",
];

/** One character frame per viseme. Sprites live in public/face/. */
export const MOUTH_SPRITES: Record<Viseme, string> = {
  rest: "face/rest.png",
  MBP: "face/MBP.png",
  AI: "face/AI.png",
  E: "face/E.png",
  O: "face/O.png",
  U: "face/U.png",
  FV: "face/FV.png",
  L: "face/L.png",
  WQ: "face/WQ.png",
};

type Shape = Exclude<Viseme, "rest">;

/** Quarter-open phase (`*q`) — the first third of the jaw's travel. */
export const QUARTER_SPRITES: Record<Shape, string> = {
  MBP: "face/MBPq.png",
  AI: "face/AIq.png",
  E: "face/Eq.png",
  O: "face/Oq.png",
  U: "face/Uq.png",
  FV: "face/FVq.png",
  L: "face/Lq.png",
  WQ: "face/WQq.png",
};

/** Half-open phase (`*h`) — midway through the jaw's travel. */
export const HALF_SPRITES: Record<Shape, string> = {
  MBP: "face/MBPh.png",
  AI: "face/AIh.png",
  E: "face/Eh.png",
  O: "face/Oh.png",
  U: "face/Uh.png",
  FV: "face/FVh.png",
  L: "face/Lh.png",
  WQ: "face/WQh.png",
};

type FrameKey = Viseme | `${Shape}h` | `${Shape}q`;

const SHAPES = Object.keys(HALF_SPRITES) as Shape[];

const FRAME_KEYS: readonly FrameKey[] = [
  ...VISEMES,
  ...SHAPES.map((v) => `${v}h` as FrameKey),
  ...SHAPES.map((v) => `${v}q` as FrameKey),
];

function spriteOf(key: FrameKey): string {
  if (key.endsWith("q")) return QUARTER_SPRITES[key.slice(0, -1) as Shape];
  if (key.endsWith("h")) return HALF_SPRITES[key.slice(0, -1) as Shape];
  return MOUTH_SPRITES[key as Viseme];
}

/** Frames of one viseme in increasing openness; the builder enforces the order. */
function phasesOf(shape: Shape): readonly FrameKey[] {
  return ["rest", `${shape}q` as FrameKey, `${shape}h` as FrameKey, shape as FrameKey];
}

/** Frames per viseme: closed, quarter, half, full. */
const PHASE_COUNT = 4;

/** How far each viseme opens the mouth, from measured cavity area per frame. */
const OPENNESS: Record<Viseme, number> = {
  rest: 0,
  MBP: 0.25,
  WQ: 0.4,
  FV: 0.45,
  U: 0.5,
  E: 0.75,
  L: 0.8,
  O: 0.85,
  AI: 1,
};

/** Exponential approach to the target, ~200 ms. Invariants: docs/mouth.md */
const SMOOTH_PER_MS = 0.005;

/** Animation frame step at 60 Hz — the clock the jaw's inertia runs on. */
const FRAME_MS = 16.7;

/**
 * Minimum hold time for the mouth SHAPE (which of the eight frames we show).
 * Standard 2D lip-sync practice is frame-holding for ~3 frames: without it the
 * shape changes faster than the eye can read as articulation.
 */
const SHAPE_HOLD_MS = 150;

/** Cross-over time for a shape change; an instant swap reads as flipping stills. */
const SHAPE_FADE_MS = 90;

/** Per-frame easing of every layer's opacity; a one-frame drop to zero is visible. */
const LAYER_EASE = 0.25;

/** Speech rarely peaks, so a normal level is scaled onto the full range of poses. */
const LEVEL_GAIN = 3.2;

/** Below this the mouth is shut: the noise floor otherwise holds it ajar. */
const LEVEL_FLOOR = 0.02;

/**
 * Dead zone near the closed mouth: below this openness we treat it as shut.
 * The amplitude is rescaled from the threshold rather than clipped at it —
 * otherwise the mouth popped open on every entry into speech.
 */
const CLOSED_BELOW = 0.12;

export function Mouth({
  timeline,
  playback,
  outputLevel,
}: {
  timeline: VisemeTimeline;
  playback: PlaybackLike;
  /**
   * Real output loudness, 0..1, sampled per frame. When present it drives how far the
   * mouth opens, and the timeline only picks which shape.
   *
   * Driving the amplitude from the alignment instead was the "sometimes it talks and the
   * mouth does not move" bug: alignment does not arrive for every chunk and can drift
   * from the audio, whereas loudness cannot — sound means an open mouth by definition.
   */
  outputLevel?: () => number;
}) {
  const frames = useRef(new Map<FrameKey, HTMLImageElement>());

  useEffect(() => {
    let raf = 0;
    let openness = 0;
    // The shape runs on its own clock: the target comes from the timeline, but
    // we switch no more often than SHAPE_HOLD_MS, or it cycles faster than visible.
    let shape: Exclude<Viseme, "rest"> = "AI";
    let shapeAt = -Infinity;
    // The shape being faded out, and how many animation frames into that crossfade we
    // are. Counted in frames, not from the playhead: while audio is paused elapsedMs
    // does not advance, and a crossfade measured against it would hang half-done.
    let prevShape: Exclude<Viseme, "rest"> | null = null;
    let fadeFrames = 0;
    // What each layer is currently showing, so it can be eased toward its next value
    // instead of jumping there.
    const shown = new Map<FrameKey, number>();

    const setOpacity = (key: FrameKey, value: number) => {
      const el = frames.current.get(key);
      if (el) el.style.opacity = value.toFixed(3);
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Two clocks on purpose: the target comes from the playhead so the mouth cannot
      // drift from the sound, while the inertia counts animation frames — on a paused
      // playhead it would otherwise freeze half-way to a shape.
      const now = playback.elapsedMs;
      const viseme = timeline.at(now);
      const measured = outputLevel?.();
      if (viseme !== "rest" && viseme !== shape && now - shapeAt >= SHAPE_HOLD_MS) {
        prevShape = shape;
        shape = viseme;
        shapeAt = now;
        fadeFrames = 0;
      }

      // Exponential approach to the target: step size is proportional to the
      // remaining distance, so it starts fast and eases into the shape.
      // Silence must mean a shut mouth: no viseme may hold it open on its own.
      let target: number;
      if (measured === undefined) {
        target = OPENNESS[viseme];
      } else if (measured < LEVEL_FLOOR) {
        target = 0;
      } else {
        const loudness = Math.min(1, (measured - LEVEL_FLOOR) * LEVEL_GAIN);
        target = loudness * (OPENNESS[viseme] || OPENNESS.AI);
      }
      const k = 1 - Math.exp(-SMOOTH_PER_MS * FRAME_MS);
      openness += (target - openness) * k;

      // Two neighbouring phases at a time, with weights summing to one.
      // Weight of the incoming shape against the one it replaces.
      const blend =
        prevShape === null ? 1 : Math.min(1, (fadeFrames * FRAME_MS) / SHAPE_FADE_MS);
      if (prevShape !== null) fadeFrames++;
      if (blend >= 1) prevShape = null;


      const t = Math.min(
        1,
        Math.max(0, (openness - CLOSED_BELOW) / (1 - CLOSED_BELOW)),
      );
      const seg = Math.min(PHASE_COUNT - 2, Math.floor(t * (PHASE_COUNT - 1)));
      const frac = t * (PHASE_COUNT - 1) - seg;

      // The outgoing shape gets the same split, so a change crosses over.
      const active: Array<[FrameKey, number]> = [];
      const spread = (target: Exclude<Viseme, "rest">, weight: number) => {
        if (weight <= 0.001) return;
        const ph = phasesOf(target);
        const lo = ph[seg];
        const up = ph[seg + 1];
        if (lo !== "rest") active.push([lo, (1 - frac) * weight]);
        active.push([up, frac * weight]);
      };
      spread(shape, blend);
      if (prevShape !== null) spread(prevShape, 1 - blend);

      // Every layer eases toward its target rather than being written to it.
      const targets = new Map(active);
      for (const key of FRAME_KEYS) {
        if (key === "rest") continue;
        const want = targets.get(key) ?? 0;
        const have = shown.get(key) ?? 0;
        if (want === 0 && have < 0.004) {
          if (have !== 0) {
            shown.set(key, 0);
            setOpacity(key, 0);
          }
          continue;
        }
        const next = have + (want - have) * LAYER_EASE;
        shown.set(key, next);
        setOpacity(key, next);
      }
      // The closed frame is the backdrop the others fade in over.
      setOpacity("rest", 1);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timeline, playback, outputLevel]);

  return (
    <figure className="mouth-frame">
      <figcaption>playback</figcaption>
      <div className="mouth-stack" aria-label="Response articulation">
        {FRAME_KEYS.map((k) => (
          <img
            key={k}
            ref={(el) => {
              if (el) frames.current.set(k, el);
              else frames.current.delete(k);
            }}
            src={`${import.meta.env.BASE_URL}${spriteOf(k)}`}
            alt=""
            draggable={false}
            // Zero CSS transitions: rAF drives the amplitude, and a transition
            // on top would add a second, independent source of timing.
            style={{ opacity: k === "rest" ? 1 : 0 }}
          />
        ))}
      </div>
    </figure>
  );
}
