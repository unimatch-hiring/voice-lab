import { expect, test } from "vitest";
import { TurnModel } from "./turnModel";

test("opens a span on stage-start and closes it on stage-end", () => {
  const m = new TurnModel();
  m.apply({ type: "stage-start", stage: "stt", at: 100 });

  expect(m.activeStage).toBe("stt");
  expect(m.visible(200, 6000)).toEqual([{ stage: "stt", start: 100, end: null }]);

  m.apply({ type: "stage-end", stage: "stt", at: 300, ttfbMs: 200 });

  expect(m.activeStage).toBeNull();
  expect(m.visible(400, 6000)[0].end).toBe(300);
});

test("a repeated start closes the previous span instead of leaking it", () => {
  const m = new TurnModel();
  m.apply({ type: "stage-start", stage: "tts", at: 100 });
  m.apply({ type: "stage-start", stage: "tts", at: 500 });

  const spans = m.visible(600, 6000);
  expect(spans).toHaveLength(2);
  expect(spans[0].end).toBe(500); // первый закрыт, а не растёт вечно
});

test("overlapping stages are both visible", () => {
  const m = new TurnModel();
  m.apply({ type: "stage-start", stage: "llm", at: 100 });
  m.apply({ type: "stage-start", stage: "tts", at: 300 }); // начался до конца llm

  const stages = m.visible(400, 6000).map((s) => s.stage);
  expect(stages).toEqual(["llm", "tts"]);
});

test("prune drops spans that scrolled out of the window", () => {
  const m = new TurnModel();
  m.apply({ type: "stage-start", stage: "stt", at: 0 });
  m.apply({ type: "stage-end", stage: "stt", at: 100, ttfbMs: 100 });
  m.apply({ type: "stage-start", stage: "llm", at: 9000 });

  m.prune(10_000, 6000); // окно 6 с: спан на 0..100 уехал

  expect(m.visible(10_000, 6000).map((s) => s.stage)).toEqual(["llm"]);
});

test("prune actually shrinks the span store, not just the visible slice", () => {
  const m = new TurnModel();

  // 300 давно закрытых спанов — все за пределами окна.
  for (let i = 0; i < 300; i++) {
    m.apply({ type: "stage-start", stage: "stt", at: i * 10 });
    m.apply({ type: "stage-end", stage: "stt", at: i * 10 + 5, ttfbMs: 5 });
  }

  const before = (m as unknown as { spans: unknown[] }).spans.length;
  m.prune(1_000_000, 6000);
  const after = (m as unknown as { spans: unknown[] }).spans.length;

  expect(before).toBe(300);
  expect(after).toBe(0);
});

test("prune keeps a still-open span even if it started long ago", () => {
  const m = new TurnModel();
  m.apply({ type: "stage-start", stage: "playback", at: 0 });

  m.prune(10_000, 6000);

  expect(m.visible(10_000, 6000)).toHaveLength(1);
});

test("counts tokens and tracks the latest audio level", () => {
  const m = new TurnModel();
  m.apply({ type: "llm-token", token: "При", at: 10 });
  m.apply({ type: "llm-token", token: "вет", at: 20 });
  m.apply({ type: "audio-level", rms: 0.4, at: 30 });

  expect(m.tokens).toBe(2);
  expect(m.level).toBeCloseTo(0.4);
});

test("activeStage reports the most recently started of several open stages", () => {
  const m = new TurnModel();
  m.apply({ type: "stage-start", stage: "llm", at: 100 });
  m.apply({ type: "stage-start", stage: "tts", at: 300 }); // начался до конца llm
  m.apply({ type: "stage-start", stage: "playback", at: 450 }); // и до конца tts

  expect(m.activeStage).toBe("playback");

  // Закрылась самая поздняя — активной становится предыдущая по времени старта.
  m.apply({ type: "stage-end", stage: "playback", at: 500, ttfbMs: 50 });
  expect(m.activeStage).toBe("tts");
});

test("reset clears everything", () => {
  const m = new TurnModel();
  m.apply({ type: "stage-start", stage: "stt", at: 0 });
  m.apply({ type: "llm-token", token: "x", at: 1 });
  m.reset();

  expect(m.visible(10, 6000)).toEqual([]);
  expect(m.tokens).toBe(0);
  expect(m.activeStage).toBeNull();
});
