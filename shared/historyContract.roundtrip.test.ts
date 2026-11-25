import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEntries } from "../server/validation.js";
import { EventBus } from "../src/lib/events";
import { HistoryStream } from "../src/lib/history";
import type { TurnMetrics } from "../src/lib/types";

const ALL_STAGES_TURN: TurnMetrics = {
  stages: { capture: 40, vad: 120, stt: 180, llm: 800, tts: 350, playback: 900 },
  totalMs: 2390,
  llmTokens: 12,
  ttsChars: 80,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A real HistoryStream whose every request body is collected. */
function streamWithRecordedBodies() {
  const bus = new EventBus();
  const bodies: { entries?: unknown[] }[] = [];
  const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  const stream = new HistoryStream({
    bus,
    historyUrl: "http://history.test",
    userId: "3f2b8c1e-7d4a-4e5b-9a6c-1d2e3f4a5b6c",
    fetch: fakeFetch as typeof fetch,
    now: () => Date.now(),
    onStatus: () => {},
  });
  return { bus, stream, bodies };
}

function sentEntriesOf(bodies: { entries?: unknown[] }[]) {
  return bodies.filter((body) => body.entries).flatMap((body) => body.entries as { kind: string; endedBy?: string }[]);
}

function expectServerParsesUnchanged(bodies: { entries?: unknown[] }[]) {
  for (const body of bodies.filter((b) => b.entries)) {
    expect(parseEntries(body)).toEqual(body.entries);
  }
}

describe("what the page sends and the server parses", () => {
  // The two sides share limits through historyContract.js but not the entry shapes: this is the check that they agree.
  it("passes the entries a real HistoryStream sends through parseEntries unchanged", async () => {
    const { bus, stream, bodies } = streamWithRecordedBodies();

    bus.emit({ type: "conversation-start", conversationId: "conv_1", agentId: "agent_1", at: 0 });
    await vi.advanceTimersByTimeAsync(0);
    bus.emit({ type: "stt-result", result: { text: "Hello there", words: [] } });
    bus.emit({ type: "agent-reply", text: "Hi, how can I help?", at: 0 });
    stream.addTurn(ALL_STAGES_TURN);
    stream.end("error", "connection dropped");
    await vi.advanceTimersByTimeAsync(0);

    expect(sentEntriesOf(bodies).map((entry) => entry.kind).sort()).toEqual(["end", "line", "line", "turn"]);
    expectServerParsesUnchanged(bodies);
  });

  it("passes a resumed conversation and the closed ending of a tab that goes away", async () => {
    const { bus, stream, bodies } = streamWithRecordedBodies();

    bus.emit({ type: "conversation-start", conversationId: "conv_1", agentId: "agent_1", at: 0 });
    await vi.advanceTimersByTimeAsync(0);
    bus.emit({ type: "stt-result", result: { text: "First segment", words: [] } });
    stream.end("user");
    await vi.advanceTimersByTimeAsync(0);
    bus.emit({ type: "conversation-start", conversationId: "conv_2", agentId: "agent_1", at: 0 });
    await vi.advanceTimersByTimeAsync(0);
    bus.emit({ type: "agent-reply", text: "Second segment", at: 0 });
    stream.flushOnPageHide();

    const sentEntries = sentEntriesOf(bodies);
    expect(sentEntries.map((entry) => entry.kind)).toContain("resume");
    expect(sentEntries).toContainEqual(expect.objectContaining({ kind: "end", endedBy: "closed" }));
    expectServerParsesUnchanged(bodies);
  });
});
