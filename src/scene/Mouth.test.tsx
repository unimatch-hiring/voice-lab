import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Mouth, MOUTH_SHAPES } from "./Mouth";
import { VisemeTimeline } from "../lib/visemes";

test("ships a path for every viseme", () => {
  const visemes = ["rest", "MBP", "AI", "E", "O", "U", "FV", "L", "WQ"] as const;
  for (const v of visemes) {
    expect(MOUTH_SHAPES[v], `нет формы для ${v}`).toBeTruthy();
    expect(MOUTH_SHAPES[v].startsWith("M")).toBe(true); // валидный SVG-path
  }
});

test("closed and open shapes differ", () => {
  expect(MOUTH_SHAPES.MBP).not.toBe(MOUTH_SHAPES.AI);
  expect(MOUTH_SHAPES.rest).not.toBe(MOUTH_SHAPES.O);
});

test("mouth follows the audio playhead, not a wall clock", () => {
  const timeline = new VisemeTimeline();
  timeline.append({
    audio: new Int16Array(0),
    chars: ["м", "а"],
    charStartTimesMs: [0, 100],
    charDurationsMs: [100, 100],
  });

  // Плейхед стоит на месте: аудио не играет.
  const playback = { elapsedMs: 0, isPlaying: false, enqueue: () => {}, stop: () => {} };

  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;

  try {
    const { container } = render(<Mouth timeline={timeline} playback={playback as never} />);
    const path = container.querySelector("path")!;

    // Прокручиваем кадры, не двигая плейхед: форма обязана остаться прежней.
    frames.splice(0).forEach((cb) => cb(0));
    frames.splice(0).forEach((cb) => cb(500));
    expect(path.getAttribute("d")).toBe(MOUTH_SHAPES.MBP);

    // Двигаем ТОЛЬКО плейхед — форма обязана смениться на визиму второго символа.
    playback.elapsedMs = 150;
    frames.splice(0).forEach((cb) => cb(1000));
    expect(path.getAttribute("d")).toBe(MOUTH_SHAPES.AI);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});
