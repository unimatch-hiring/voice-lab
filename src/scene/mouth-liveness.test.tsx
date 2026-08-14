import { expect, test } from "vitest";
import { render } from "@testing-library/react";
import { Mouth } from "./Mouth";

/**
 * Regressions for the two things a viewer notices immediately: the raccoon frozen
 * with its mouth open, and an open mouth drawn as a ghost of two.
 */

/**
 * A spectrum in the layout the SDK hands out: 100–8000 Hz across 1024 bins, each
 * byte a decibel on the -100..-30 scale.
 */
function spectrum({ jaw = 0, hiss = 0 }: { jaw?: number; hiss?: number }): Uint8Array {
  const bins = 1024;
  const out = new Uint8Array(new ArrayBuffer(bins));
  const at = (hz: number) => Math.round(((hz - 100) / 7900) * bins);
  out.fill(jaw, at(200), at(900));
  out.fill(hiss, at(3000), bins);
  return out;
}

const LOUD = spectrum({ jaw: 200 });

function frameRunner() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const raf = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  let clock = 0;

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  // Cancellation is honoured: without it a torn-down loop keeps ticking here while
  // the browser would have stopped it, and the re-render case below silently
  // measures the old loop tidying up after itself.
  globalThis.cancelAnimationFrame = ((id: number) => {
    pending.delete(id);
  }) as typeof cancelAnimationFrame;

  const now = globalThis.performance.now;
  globalThis.performance.now = () => clock;

  return {
    tick(times: number) {
      for (let i = 0; i < times; i++) {
        clock += 16.7;
        const due = [...pending.entries()];
        pending.clear();
        due.forEach(([, cb]) => cb(clock));
      }
    },
    restore() {
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = cancel;
      globalThis.performance.now = now;
    },
  };
}

/** Frames drawn right now. Exactly one is meant to be. */
function litFrames(container: HTMLElement): string[] {
  return ([...container.querySelectorAll("img")] as HTMLImageElement[])
    .filter((el) => Number(el.style.opacity) > 0)
    .map((el) => el.getAttribute("src")!.split("/").pop()!.replace(".png", ""));
}

test("no sound shuts the mouth after the component re-renders mid-speech", () => {
  // App hands the mouth a callback, and used to hand it a fresh arrow on every
  // render while the animation loop listed it as a dependency. Any App state change
  // during a reply — a finished turn reporting its metrics — tore the loop down and
  // built a new one with no record of which frames were lit, so whatever was on
  // screen stayed there. The loop now starts once and reads the callback from a ref.
  let source: Uint8Array | null = LOUD;
  const frames = frameRunner();

  try {
    const { container, rerender } = render(<Mouth source={() => source} />);
    frames.tick(40);
    expect(litFrames(container), "the mouth opened").not.toEqual(["rest"]);

    // Same props, new function identity: what any App re-render produces.
    rerender(<Mouth source={() => source} />);

    source = null;
    frames.tick(120);
    expect(litFrames(container), "nothing is playing — the mouth is shut").toEqual([
      "rest",
    ]);
  } finally {
    frames.restore();
  }
});

test("no sound shuts the mouth without any re-render", () => {
  // The control: if this fails too, the cause is the closing path rather than the
  // lifetime of the loop.
  let source: Uint8Array | null = LOUD;
  const frames = frameRunner();

  try {
    const { container } = render(<Mouth source={() => source} />);
    frames.tick(40);
    expect(litFrames(container)).not.toEqual(["rest"]);

    source = null;
    frames.tick(120);
    expect(litFrames(container)).toEqual(["rest"]);
  } finally {
    frames.restore();
  }
});

test("exactly one frame is ever drawn", () => {
  // The mouth used to cross-fade neighbouring sprites, which on photographs is a
  // double exposure: half-transparent teeth over a closed muzzle, with the closed
  // frame left underneath at full opacity. Any partial opacity brings that back.
  const frames = frameRunner();
  const script = [LOUD, spectrum({ jaw: 120 }), spectrum({ jaw: 90, hiss: 200 }), null];
  let i = 0;

  try {
    const { container } = render(<Mouth source={() => script[i % script.length]} />);

    for (let step = 0; step < 200; step++) {
      i = Math.floor(step / 12);
      frames.tick(1);
      const opacities = ([...container.querySelectorAll("img")] as HTMLImageElement[])
        .map((el) => Number(el.style.opacity))
        .filter((o) => o > 0);
      expect(opacities.length, `frames drawn at step ${step}`).toBe(1);
      expect(opacities[0], `partial opacity at step ${step}`).toBe(1);
    }
  } finally {
    frames.restore();
  }
});
