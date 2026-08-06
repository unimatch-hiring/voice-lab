import { expect, test } from "vitest";
import { render, act } from "@testing-library/react";
import { Waterfall } from "./Waterfall";
import { EventBus } from "../lib/events";
import type { StageName } from "../lib/types";

/**
 * Guardrail для правила из CLAUDE.md: высокочастотные данные живут в refs.
 * Считаем вызовы самой функции Waterfall — setState внутри неё перерисовывает
 * её саму, а не обёртку, поэтому счётчик должен стоять на компоненте.
 */
function countingWaterfall() {
  let renders = 0;
  const Counted = (props: { bus: EventBus }) => {
    renders++;
    return Waterfall(props);
  };
  return { Counted, count: () => renders };
}

test("a burst of high-frequency events causes no re-renders", () => {
  const bus = new EventBus();
  const { Counted, count } = countingWaterfall();

  render(<Counted bus={bus} />);
  const initial = count();

  act(() => {
    for (let i = 0; i < 200; i++) {
      bus.emit({ type: "audio-level", rms: Math.random(), at: i * 10 });
    }
    for (let i = 0; i < 60; i++) {
      bus.emit({ type: "llm-token", token: "сло", at: 2000 + i * 33 });
    }
  });

  expect(count()).toBe(initial);
});

test("stage events do not re-render either", () => {
  const bus = new EventBus();
  const { Counted, count } = countingWaterfall();

  render(<Counted bus={bus} />);
  const initial = count();

  const stages: StageName[] = ["capture", "vad", "stt", "llm", "tts", "playback"];
  act(() => {
    for (const stage of stages) {
      bus.emit({ type: "stage-start", stage, at: 0 });
      bus.emit({ type: "stage-end", stage, at: 100, ttfbMs: 100 });
    }
  });

  expect(count()).toBe(initial);
});
