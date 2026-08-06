import { expect, test } from "vitest";
import { render } from "@testing-library/react";
import { Mouth, MOUTH_SPRITES } from "./Mouth";
import { VisemeTimeline } from "../lib/visemes";
import type { Viseme } from "../lib/visemes";

const VISEMES: Viseme[] = ["rest", "MBP", "AI", "E", "O", "U", "FV", "L", "WQ"];

test("ships a sprite for every viseme", () => {
  for (const v of VISEMES) {
    expect(MOUTH_SPRITES[v], `нет спрайта для ${v}`).toBeTruthy();
    expect(MOUTH_SPRITES[v].endsWith(".png")).toBe(true);
  }
});

test("every viseme maps to its own file", () => {
  const files = VISEMES.map((v) => MOUTH_SPRITES[v]);
  expect(new Set(files).size).toBe(VISEMES.length);
});

/** Визима первого символа фразы — по ней проверяем стартовый кадр. */
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

test("mouth follows the audio playhead, not a wall clock", () => {
  const timeline = timelineOf(["м", "а"]);
  // Плейхед стоит: аудио не играет.
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
    const shown = () =>
      [...container.querySelectorAll("img")]
        .filter((el) => (el as HTMLImageElement).style.opacity === "1")
        .map((el) => (el as HTMLImageElement).getAttribute("src"));

    // Кадры крутятся с разным временем, плейхед не двигается — форма стоит.
    frames.splice(0).forEach((cb) => cb(0));
    frames.splice(0).forEach((cb) => cb(500));
    expect(shown()).toEqual([expect.stringContaining(MOUTH_SPRITES.MBP)]);

    // Двигаем ТОЛЬКО плейхед — кадр обязан смениться.
    playback.elapsedMs = 150;
    frames.splice(0).forEach((cb) => cb(1000));
    expect(shown()).toEqual([expect.stringContaining(MOUTH_SPRITES.AI)]);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});

test("exactly one frame is visible at a time", () => {
  const timeline = timelineOf(["м", "а", "о"]);
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
    const visible = () =>
      [...container.querySelectorAll("img")].filter(
        (el) => (el as HTMLImageElement).style.opacity === "1",
      ).length;

    for (const at of [0, 150, 250, 900]) {
      playback.elapsedMs = at;
      frames.splice(0).forEach((cb) => cb(at));
      expect(visible(), `на ${at} мс видно не ровно один кадр`).toBe(1);
    }
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});
