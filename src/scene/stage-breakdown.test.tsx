import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StageBreakdown } from "./StageBreakdown";

afterEach(cleanup);

test("end to end shows the turn's wall-clock time, not the sum of overlapping stages", () => {
  // stt runs inside capture, tts inside playback: the stages add up to 3900 ms of a 2000 ms turn.
  render(
    <StageBreakdown
      metrics={{
        stages: { capture: 800, stt: 400, llm: 300, tts: 1200, playback: 1200 },
        totalMs: 2000,
        llmTokens: 3,
        ttsChars: 12,
      }}
    />,
  );

  expect(screen.getByText(/end to end/).textContent).toContain("2000");
});

test("a stage longer than the turn fills its track but keeps the real share", () => {
  // tts runs past the end of a 1000 ms turn: 1500 ms is 150% of it.
  const { container } = render(
    <StageBreakdown metrics={{ stages: { stt: 500, tts: 1500 }, totalMs: 1000, llmTokens: 3, ttsChars: 12 }} />,
  );

  const bars = container.querySelectorAll<HTMLElement>(".breakdown-bar");
  expect(Array.from(bars, (bar) => bar.style.width)).toEqual(["50%", "100%"]);
  expect(screen.getByText("150%")).toBeTruthy();
});
