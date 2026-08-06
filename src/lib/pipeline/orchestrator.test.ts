import { expect, test, vi } from "vitest";
import { Orchestrator } from "./orchestrator";
import { EventBus } from "../events";
import type { PipelineEvent, TtsChunk } from "../types";

function harness(overrides: Partial<Record<string, unknown>> = {}) {
  const bus = new EventBus();
  const seen: PipelineEvent[] = [];
  bus.on((e) => seen.push(e));

  let clock = 0;
  const now = () => (clock += 100);

  const chunk: TtsChunk = {
    audio: new Int16Array(16),
    chars: ["п", "р"],
    charStartTimesMs: [0, 50],
    charDurationsMs: [50, 50],
  };

  const enqueued: TtsChunk[] = [];
  const deps = {
    bus,
    now,
    transcribe: vi.fn(async () => ({
      text: "привет",
      words: [{ text: "привет", start: 0, end: 0.5, confidence: 0.9 }],
    })),
    respond: vi.fn(async function* () {
      yield "При";
      yield "вет";
    }),
    synthesize: vi.fn(async function* () {
      yield chunk;
    }),
    playback: {
      enqueue: (c: TtsChunk) => enqueued.push(c),
      stop: () => {},
      get elapsedMs() { return 0; },
      get isPlaying() { return false; },
    },
    ...overrides,
  };

  return { bus, seen, deps, enqueued, chunk };
}

test("runs the stages in order and reports metrics for each", async () => {
  const { seen, deps } = harness();
  const orch = new Orchestrator(deps as never);

  const metrics = await orch.runTurn(new Blob(["x"]));

  const ended = seen.filter((e) => e.type === "stage-end").map((e) => (e as { stage: string }).stage);
  expect(ended).toEqual(["stt", "llm", "tts", "playback"]);
  expect(metrics.stages.stt).toBeGreaterThan(0);
  expect(metrics.llmTokens).toBe(2);
  expect(metrics.ttsChars).toBe(2);
});

test("emits turn-start first and turn-end last", async () => {
  const { seen, deps } = harness();
  const orch = new Orchestrator(deps as never);

  await orch.runTurn(new Blob(["x"]));

  expect(seen[0].type).toBe("turn-start");
  expect(seen[seen.length - 1].type).toBe("turn-end");
});

test("feeds tts chunks to playback and to the viseme timeline", async () => {
  const { deps, enqueued } = harness();
  const orch = new Orchestrator(deps as never);

  await orch.runTurn(new Blob(["x"]));

  expect(enqueued).toHaveLength(1);
  expect(orch.timeline.totalMs).toBe(100);
});

test("keeps the conversation history across turns", async () => {
  const { deps } = harness();
  const orch = new Orchestrator(deps as never);

  await orch.runTurn(new Blob(["x"]));
  await orch.runTurn(new Blob(["x"]));

  expect(orch.history).toEqual([
    { role: "user", content: "привет" },
    { role: "assistant", content: "Привет" },
    { role: "user", content: "привет" },
    { role: "assistant", content: "Привет" },
  ]);
  const secondCall = (deps.respond as ReturnType<typeof vi.fn>).mock.calls[1];
  expect(secondCall[1].history).toHaveLength(2);
});

test("a failing stage emits stage-error and does not run later stages", async () => {
  const { seen, deps } = harness({
    transcribe: vi.fn(async () => { throw new Error("scribe is down"); }),
  });
  const orch = new Orchestrator(deps as never);

  await expect(orch.runTurn(new Blob(["x"]))).rejects.toThrow("scribe is down");

  const err = seen.find((e) => e.type === "stage-error");
  expect(err).toMatchObject({ stage: "stt", message: "scribe is down" });
  expect(seen.some((e) => e.type === "stage-end" && (e as { stage: string }).stage === "llm")).toBe(false);
});

test("reset clears history and timeline between sessions", async () => {
  const { deps } = harness();
  const orch = new Orchestrator(deps as never);

  await orch.runTurn(new Blob(["x"]));
  orch.reset();

  expect(orch.history).toEqual([]);
  expect(orch.timeline.totalMs).toBe(0);
});
