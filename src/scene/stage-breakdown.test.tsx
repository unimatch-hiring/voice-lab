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
