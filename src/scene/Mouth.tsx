import { useEffect, useRef } from "react";
import { FRAME_KEYS, spriteOf } from "../lib/mouthFrames";
import { frameOf, step, INITIAL, type MouthState } from "../lib/mouthFrame";
import { mouthLevel } from "../lib/mouthLevel";
import { shapeOf } from "../lib/mouthShape";

/**
 * The character articulating the reply, driven by the sound actually leaving the
 * speaker. Which frame and when: `mouthFrame.ts`. Which sprites exist and in what
 * order they open: `mouthFrames.ts`. Invariants: docs/mouth.md
 */

/** The spectrum of the audio playing right now, or null when nothing is. */
export type MouthSource = () => Uint8Array | null;

export function Mouth({ source }: { source: MouthSource }) {
  const frames = useRef(new Map<string, HTMLImageElement>());

  // The callback lives in a ref and the loop starts once. Depending on the prop
  // instead cost us the worst-looking defect in the product: App passes a fresh
  // arrow every render, so any state change during a reply — a finished turn
  // reporting its metrics — tore the loop down mid-motion and started a new one
  // that had no record of which frames were lit, leaving the raccoon frozen with
  // its mouth open until the page was reloaded.
  const read = useRef<MouthSource>(source);
  read.current = source;

  useEffect(() => {
    let raf = 0;
    let state: MouthState = INITIAL;
    let shown = "";
    let last = performance.now();

    const show = (key: string) => {
      if (key === shown) return;
      frames.current.get(shown)?.style.setProperty("opacity", "0");
      frames.current.get(key)?.style.setProperty("opacity", "1");
      shown = key;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      // Clamped: a backgrounded tab resumes with a gap of seconds, and feeding
      // that in as one step would close the mouth and snap it back.
      const dt = Math.min(100, now - last);
      last = now;

      const spectrum = read.current();
      state = spectrum
        ? step(state, mouthLevel(spectrum), shapeOf(spectrum), dt)
        : step(state, null, state.shape, dt);
      show(frameOf(state));
    };

    // A hidden tab stops rAF, so the loop freezes on whatever frame was up. Coming
    // back to a raccoon holding a vowel it finished saying a minute ago is the same
    // defect as any other stuck mouth, so leaving is treated as the sound stopping.
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      state = { ...INITIAL, shape: state.shape };
      show(frameOf(state));
      last = performance.now();
    };
    document.addEventListener("visibilitychange", onHidden);

    show(frameOf(INITIAL));
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

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
            // Opacity is only ever 0 or 1. A partial value would composite one
            // mouth over another, which is where the ghosting came from.
            style={{ opacity: 0 }}
          />
        ))}
      </div>
    </figure>
  );
}
