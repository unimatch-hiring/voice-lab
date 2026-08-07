import { useEffect, useRef } from "react";
import type { Viseme, VisemeTimeline } from "../lib/visemes";
import type { PlaybackLike } from "../lib/pipeline/orchestrator";

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

/**
 * Frames of one viseme in increasing openness. The sprite builder enforces this
 * order empirically (it swaps phases when the generator misses), so
 * interpolating between neighbours is safe.
 */
function phasesOf(shape: Shape): readonly FrameKey[] {
  return ["rest", `${shape}q` as FrameKey, `${shape}h` as FrameKey, shape as FrameKey];
}

/**
 * Target openness per viseme. The sprites were drawn wide open, but phonemes
 * open the mouth to different degrees: /m/ closes the lips, /a/ flings them open.
 * Dark-cavity measurement across frames: MBP/WQ/FV/U ~17-19%, E/O/L ~23-25%, AI ~26%.
 */
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

/**
 * Per-frame amplitude smoothing (exponential, ~200 ms to target). The jaw is
 * inertial mechanics: it travels toward a target instead of snapping between
 * shapes. That is exactly what the old "discrete frame + CSS fade" scheme could
 * not do: at 10-15 changes per second the fade never finished, frames flashed
 * for 16 ms each and the whole thing read as jitter. Here there is nothing to
 * jitter — the amplitude is continuous.
 *
 * Smoothing costs us full extremes and some lag behind the audio, but not much:
 * on the Russian fixture the range is 0.81 out of 0.90 with 33 ms of lag
 * (invisible to the eye), while the jerk drops 3.5x, to 0.014.
 */
const SMOOTH_PER_MS = 0.005;

/** Animation frame step at 60 Hz — the clock the jaw's inertia runs on. */
const FRAME_MS = 16.7;

/**
 * Minimum hold time for the mouth SHAPE (which of the eight frames we show).
 * Standard 2D lip-sync practice is frame-holding for ~3 frames: without it the
 * shape changes faster than the eye can read as articulation.
 */
const SHAPE_HOLD_MS = 150;

/**
 * Dead zone near the closed mouth: below this openness we treat it as shut.
 * The amplitude is rescaled from the threshold rather than clipped at it —
 * otherwise the mouth popped open on every entry into speech.
 */
const CLOSED_BELOW = 0.12;

export function Mouth({
  timeline,
  playback,
}: {
  timeline: VisemeTimeline;
  playback: PlaybackLike;
}) {
  const frames = useRef(new Map<FrameKey, HTMLImageElement>());

  useEffect(() => {
    let raf = 0;
    let openness = 0;
    // The shape runs on its own clock: the target comes from the timeline, but
    // we switch no more often than SHAPE_HOLD_MS, or it cycles faster than visible.
    let shape: Exclude<Viseme, "rest"> = "AI";
    let shapeAt = -Infinity;
    // Which frames are currently lit — so we can dim those on a shape change
    // instead of walking all 25 every tick.
    let lit: FrameKey[] = [];

    const setOpacity = (key: FrameKey, value: number) => {
      const el = frames.current.get(key);
      if (el) el.style.opacity = value.toFixed(3);
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Two clocks, deliberately. The openness TARGET is read off the audio
      // playhead — otherwise the mouth would drift out of sync with the sound.
      // The jaw's INERTIA runs on animation frames: while audio is paused
      // `elapsedMs` does not advance, so the mouth would freeze mid-travel.
      const now = playback.elapsedMs;
      const viseme = timeline.at(now);
      if (viseme !== "rest" && viseme !== shape && now - shapeAt >= SHAPE_HOLD_MS) {
        shape = viseme;
        shapeAt = now;
      }

      // Exponential approach to the target: step size is proportional to the
      // remaining distance, so it starts fast and eases into the shape.
      const target = OPENNESS[viseme];
      const k = 1 - Math.exp(-SMOOTH_PER_MS * FRAME_MS);
      openness += (target - openness) * k;

      // Spread the amplitude across four frames (rest -> q -> h -> full): find
      // the segment we are in and show exactly two neighbours with weights that
      // SUM to one. The constant sum matters: back when layers stacked, the
      // second half of the opening lit two frames at 100%, total density reached
      // 2.0 and it read as a jerk mid-motion. Three segments instead of one give
      // a four times smaller step between adjacent poses.
      const phases = phasesOf(shape);
      // Rescale from the silence threshold instead of clipping at it. While it
      // simply zeroed the amplitude, crossing it made total opacity jump from 0
      // straight to 0.36 — the mouth "switched on" with a jerk on every entry
      // into speech.
      const t = Math.min(
        1,
        Math.max(0, (openness - CLOSED_BELOW) / (1 - CLOSED_BELOW)),
      );
      const seg = Math.min(phases.length - 2, Math.floor(t * (phases.length - 1)));
      const frac = t * (phases.length - 1) - seg;
      const lower = phases[seg];
      const upper = phases[seg + 1];

      for (const key of lit) {
        if (key !== lower && key !== upper && key !== "rest") setOpacity(key, 0);
      }
      lit = [lower, upper];
      if (lower !== "rest") setOpacity(lower, 1 - frac);
      setOpacity(upper, frac);
      // The closed frame is the backdrop: every other layer fades in on top of
      // it, so there is no visible seam between "shut" and "slightly open".
      setOpacity("rest", 1);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timeline, playback]);

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
