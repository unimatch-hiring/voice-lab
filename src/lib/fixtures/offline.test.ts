import { expect, test, vi } from "vitest";
import { FIXTURES, offlineStages } from "./index";
import { Orchestrator } from "../pipeline/orchestrator";
import { EventBus } from "../events";
import type { PipelineEvent } from "../types";

test("ships at least one fixture", () => {
  expect(FIXTURES.length).toBeGreaterThan(0);
  for (const f of FIXTURES) {
    expect(f.chunks.length).toBeGreaterThan(0);
    expect(f.stt.text.length).toBeGreaterThan(0);
  }
});

test("a fixture runs end to end through the real orchestrator", async () => {
  const bus = new EventBus();
  const seen: PipelineEvent[] = [];
  bus.on((e) => seen.push(e));

  const fixture = FIXTURES[0];
  const enqueued: unknown[] = [];
  const orch = new Orchestrator({
    bus,
    now: (() => { let t = 0; return () => (t += 10); })(),
    ...offlineStages(fixture, 0),
    playback: {
      enqueue: (c) => enqueued.push(c),
      stop: () => {},
      get elapsedMs() { return 0; },
      get isPlaying() { return false; },
    },
  });

  const metrics = await orch.runTurn(new Blob([]));

  expect(seen[0].type).toBe("turn-start");
  expect(seen[seen.length - 1].type).toBe("turn-end");
  expect(enqueued.length).toBe(fixture.chunks.length);
  expect(metrics.stages.stt).toBeGreaterThan(0);
  expect(orch.history.at(-1)).toEqual({ role: "assistant", content: fixture.reply });
});

test("offline replies stream token by token, not in one lump", async () => {
  const fixture = FIXTURES[0];
  const { respond } = offlineStages(fixture, 0);

  const tokens: string[] = [];
  for await (const t of respond(fixture.stt.text, { history: [] })) tokens.push(t);

  expect(tokens.length).toBeGreaterThan(1);
  expect(tokens.join("")).toBe(fixture.reply);
});

test("long text is split into several chunks", () => {
  const long = FIXTURES.find((f) => f.reply.length > 40);
  expect(long, "нужна фикстура с ответом длиннее одного чанка").toBeTruthy();
  expect(long!.chunks.length).toBeGreaterThan(1);

  // Тайминги внутри чанка отсчитываются от его начала.
  for (const c of long!.chunks) {
    expect(c.charStartTimesMs[0]).toBe(0);
    expect(c.chars.length).toBe(c.charStartTimesMs.length);
    expect(c.chars.length).toBe(c.charDurationsMs.length);
  }
});

test("fixture transcripts carry word-level timings", () => {
  for (const f of FIXTURES) {
    expect(f.stt.words.length).toBeGreaterThan(0);
    expect(f.stt.words.map((w) => w.text).join(" ")).toBe(f.stt.text);
    for (const w of f.stt.words) {
      expect(w.end).toBeGreaterThan(w.start);
      expect(w.confidence).toBeGreaterThan(0);
      expect(w.confidence).toBeLessThanOrEqual(1);
    }
  }
});
