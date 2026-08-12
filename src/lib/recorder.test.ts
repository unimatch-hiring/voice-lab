import { describe, expect, it } from "vitest";
import { EventBus } from "./events";
import { Recorder, fixtureFilename, toFixtureJson } from "./recorder";
import type { TurnMetrics } from "./types";

const METRICS: TurnMetrics = { stages: { llm: 120 }, llmTokens: 7, ttsChars: 42 };

/** Clock doubles: a fixture must not depend on when the suite happens to run. */
function recorder(times: number[] = []) {
  const bus = new EventBus();
  let i = 0;
  const now = () => times[Math.min(i++, times.length - 1)] ?? 0;
  return { bus, rec: new Recorder(bus, now, () => 1_700_000_000_000) };
}

describe("recording a conversation", () => {
  it("keeps both sides in the order they were said", () => {
    const { bus, rec } = recorder([0, 100, 400]);
    rec.start();
    bus.emit({ type: "stt-result", result: { text: "hello", words: [] } });
    bus.emit({ type: "agent-reply", text: "hi there", at: 0 });

    expect(rec.stop()?.lines).toEqual([
      { speaker: "user", text: "hello", atMs: 100 },
      { speaker: "agent", text: "hi there", atMs: 400 },
    ]);
  });

  it("times lines from the start of the recording, not from page load", () => {
    const { bus, rec } = recorder([5_000, 5_250]);
    rec.start();
    bus.emit({ type: "stt-result", result: { text: "hello", words: [] } });

    expect(rec.stop()?.lines[0].atMs).toBe(250);
  });

  it("records the metrics of each turn — they arrive by callback, not on the bus", () => {
    const { rec } = recorder();
    rec.start();
    rec.addTurn(METRICS);
    rec.addTurn(METRICS);

    expect(rec.stop()?.turns).toEqual([METRICS, METRICS]);
  });

  it("ignores turns reported while not recording", () => {
    const { bus, rec } = recorder();
    rec.addTurn(METRICS);
    rec.start();
    bus.emit({ type: "stt-result", result: { text: "hello", words: [] } });

    expect(rec.stop()?.turns).toEqual([]);
  });

  it("returns nothing when no one spoke, so empty fixtures are not saved", () => {
    const { rec } = recorder();
    rec.start();
    expect(rec.stop()).toBeNull();
  });

  it("stops listening after stop, so the next conversation does not append to this one", () => {
    const { bus, rec } = recorder();
    rec.start();
    bus.emit({ type: "stt-result", result: { text: "one", words: [] } });
    const first = rec.stop();

    bus.emit({ type: "stt-result", result: { text: "two", words: [] } });
    expect(first?.lines).toHaveLength(1);
    expect(rec.isRecording).toBe(false);
  });

  it("drops blank lines that the recogniser sometimes emits", () => {
    const { bus, rec } = recorder();
    rec.start();
    bus.emit({ type: "stt-result", result: { text: "   ", words: [] } });
    bus.emit({ type: "agent-reply", text: "real", at: 0 });

    expect(rec.stop()?.lines.map((l) => l.text)).toEqual(["real"]);
  });

  it("starts clean on a second recording", () => {
    const { bus, rec } = recorder();
    rec.start();
    bus.emit({ type: "stt-result", result: { text: "first", words: [] } });
    rec.stop();

    rec.start();
    bus.emit({ type: "stt-result", result: { text: "second", words: [] } });
    expect(rec.stop()?.lines.map((l) => l.text)).toEqual(["second"]);
  });
});

describe("exporting a fixture", () => {
  it("names the file after the recording and writes readable JSON", () => {
    const { bus, rec } = recorder();
    rec.start();
    bus.emit({ type: "agent-reply", text: "hi", at: 0 });
    const conversation = rec.stop()!;

    expect(fixtureFilename(conversation)).toMatch(/^conversation-[\dTZ-]+\.json$/);
    const json = toFixtureJson(conversation);
    expect(json).toContain('\n  "lines"');
    expect(JSON.parse(json).lines[0].text).toBe("hi");
  });
});
