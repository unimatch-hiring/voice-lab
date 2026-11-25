import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./events";
import { HistoryStream, type HistoryEntry, type HistoryStatus, type HistorySummary } from "./history";
import type { TurnMetrics } from "./types";

const HISTORY_URL = "http://history.test";
const USER_ID = "3f2b8c1e-7d4a-4e5b-9a6c-1d2e3f4a5b6c";
const CONVERSATION_ID = "conv_abc123";
const AGENT_ID = "agent_xyz";
const START_MS = 1_000;

interface RecordedRequest {
  url: string;
  method: string | undefined;
  userHeader: string | null;
  keepalive: boolean | undefined;
  body: { conversationId?: string; agentId?: string; entries?: HistoryEntry[] };
  bodyBytes: number;
  sentAtMs: number;
}

/** `signal` is the request's AbortSignal, which a real fetch honours by rejecting. */
type Answer = (signal?: AbortSignal) => Response | Promise<Response>;

const ok: Answer = () => new Response("{}", { status: 200 });
const status =
  (code: number): Answer =>
  () =>
    new Response("{}", { status: code });
const networkError: Answer = () => Promise.reject(new TypeError("Failed to fetch"));
/** The server took the request and never answers; only an abort ends it. */
const neverAnswers: Answer = (signal) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
/** A server that is down until `backAtMs` on the fake clock and then accepts everything. */
const downUntil =
  (backAtMs: number): Answer =>
  () =>
    Date.now() < backAtMs ? Promise.reject(new TypeError("Failed to fetch")) : new Response("{}", { status: 200 });

/** An answer the test releases itself, so it decides when a request is still in flight. */
function heldAnswer(): { answer: Answer; release: (response?: Response) => void } {
  let release: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => pending, release: (response = ok() as Response) => release(response) };
}

/** Answers requests from `script` in order, then 200 for everything after it. */
function createFakeFetch(script: Answer[] = []) {
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const acknowledgedEntries: HistoryEntry[] = [];
  const remaining = [...script];

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const index = requests.push({
      url: String(input),
      method: init?.method,
      userHeader: new Headers(init?.headers).get("x-history-user"),
      keepalive: init?.keepalive,
      body: JSON.parse(String(init?.body ?? "{}")),
      bodyBytes: new TextEncoder().encode(String(init?.body ?? "")).length,
      sentAtMs: Date.now(),
    }) - 1;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const response = await (remaining.shift() ?? ok)(init?.signal ?? undefined);
      if (response.ok) acknowledgedEntries.push(...(requests[index].body.entries ?? []));
      return response;
    } finally {
      inFlight--;
    }
  };

  return {
    fetch: fakeFetch as typeof fetch,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    openRequests: () => requests.filter((r) => r.url === `${HISTORY_URL}/conversations`),
    entryRequests: () =>
      requests.filter((r) => r.url === `${HISTORY_URL}/conversations/${CONVERSATION_ID}/entries`),
    sentEntries: () => requests.flatMap((r) => r.body.entries ?? []),
    /** What the server would hold: entries from requests it answered with success. */
    acknowledgedEntries,
  };
}

const metrics: TurnMetrics = {
  stages: { stt: 120, llm: 800 },
  totalMs: 2400,
  llmTokens: 12,
  ttsChars: 80,
};

function setup(script: Answer[] = []) {
  const bus = new EventBus();
  const clock = { nowMs: START_MS };
  const server = createFakeFetch(script);
  const statuses: HistoryStatus[] = [];
  /** The final statuses only: `saving` is the step before them, not an outcome. */
  const outcomes: { outcome: "saved" | "notSaved"; summary: HistorySummary | null }[] = [];
  const stream = new HistoryStream({
    bus,
    historyUrl: HISTORY_URL,
    userId: USER_ID,
    fetch: server.fetch,
    now: () => clock.nowMs,
    onStatus: (status) => {
      statuses.push(status);
      if (status.kind === "saved") outcomes.push({ outcome: "saved", summary: status.summary });
      if (status.kind === "notSaved") outcomes.push({ outcome: "notSaved", summary: null });
    },
  });

  return {
    stream,
    server,
    statuses,
    outcomes,
    clock,
    connect: (conversationId = CONVERSATION_ID) =>
      bus.emit({
        type: "conversation-start",
        conversationId,
        agentId: AGENT_ID,
        at: clock.nowMs,
      }),
    userSays: (text: string) =>
      bus.emit({ type: "stt-result", result: { text, words: [] } }),
    agentSays: (text: string) => bus.emit({ type: "agent-reply", text, at: clock.nowMs }),
    /** Lets promise callbacks and timers due within `ms` run. */
    advance: (ms = 0) => vi.advanceTimersByTimeAsync(ms),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HistoryStream", () => {
  describe("before the conversation connects", () => {
    it("sends nothing, end() does nothing and no outcome is reported", async () => {
      const t = setup();

      t.userSays("Hello there");
      t.agentSays("Hi");
      t.stream.addTurn(metrics);
      t.stream.end("user");
      await t.advance(60_000);

      expect(t.server.requests).toEqual([]);
      expect(t.outcomes).toEqual([]);
    });
  });

  describe("lines said before the conversation connected", () => {
    it("are not sent once it connects", async () => {
      const t = setup();

      t.userSays("said too early");
      t.stream.addTurn(metrics);
      t.connect();
      await t.advance();

      expect(t.server.sentEntries()).toEqual([]);
    });
  });

  describe("opening and the order of lines", () => {
    it("sends the open request first, then the lines in the order they were said", async () => {
      const t = setup();

      t.connect();
      t.userSays("Hello there");
      t.agentSays("Hi, how can I help?");
      await t.advance();

      expect(t.server.requests[0].url).toBe(`${HISTORY_URL}/conversations`);
      expect(t.server.requests[0].method).toBe("POST");
      expect(t.server.requests[0].body).toEqual({
        conversationId: CONVERSATION_ID,
        agentId: AGENT_ID,
      });
      expect(t.server.sentEntries()).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "Hello there", atMs: 0 },
        { kind: "line", seq: 2, speaker: "agent", text: "Hi, how can I help?", atMs: 0 },
      ]);
    });

    it("sends lines to the conversation's entries address, after the open request", async () => {
      const t = setup();

      t.connect();
      t.userSays("Hello there");
      await t.advance();

      expect(t.server.requests.map((r) => r.url)).toEqual([
        `${HISTORY_URL}/conversations`,
        `${HISTORY_URL}/conversations/${CONVERSATION_ID}/entries`,
      ]);
    });

    it("stamps each line with the time since the conversation started on the injected clock", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.clock.nowMs = START_MS + 2_500;
      t.userSays("Hello there");
      await t.advance();

      expect(t.server.sentEntries()).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "Hello there", atMs: 2_500 },
      ]);
    });

    it("carries the user id in a header on every request and never in a URL", async () => {
      const t = setup();

      t.connect();
      t.userSays("Hello there");
      await t.advance();
      t.stream.end("user");
      await t.advance();

      expect(t.server.requests.length).toBeGreaterThanOrEqual(3);
      for (const request of t.server.requests) {
        expect(request.userHeader).toBe(USER_ID);
        expect(request.url).not.toContain(USER_ID);
      }
    });
  });

  describe("blank recognised text", () => {
    it("sends no line for whitespace-only user or agent text", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.userSays("   ");
      t.agentSays("\n\t ");
      t.userSays("");
      await t.advance(1_000);

      expect(t.server.requests).toHaveLength(1);
      expect(t.server.entryRequests()).toEqual([]);
    });

    it("does not use up a line number, so a gap in seq always means a lost line", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.userSays("   ");
      t.userSays("Hello there");
      await t.advance();

      expect(t.server.sentEntries()).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "Hello there", atMs: 0 },
      ]);
    });
  });

  describe("retry", () => {
    it("after two network failures stores every line once, with the same seq on each retry", async () => {
      const t = setup([ok, networkError, networkError, ok]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      t.agentSays("Hi");
      await t.advance(120_000);

      const entryRequests = t.server.entryRequests();
      expect(entryRequests.length).toBeGreaterThanOrEqual(3);

      const seqsByText = new Map<string, Set<number>>();
      for (const entry of t.server.sentEntries()) {
        if (entry.kind !== "line") continue;
        seqsByText.set(entry.text, (seqsByText.get(entry.text) ?? new Set()).add(entry.seq));
      }
      expect(seqsByText.get("Hello there")).toEqual(new Set([1]));
      expect(seqsByText.get("Hi")).toEqual(new Set([2]));

      // The two failed requests stored nothing; each retry repeats the request unchanged.
      expect(entryRequests[1].body).toEqual(entryRequests[0].body);
      expect(entryRequests[2].body).toEqual(entryRequests[0].body);
      expect(t.server.acknowledgedEntries).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "Hello there", atMs: 0 },
        { kind: "line", seq: 2, speaker: "agent", text: "Hi", atMs: 0 },
      ]);
    });

    it("sends the lines again in the order they were said after a failed delivery", async () => {
      const t = setup([ok, networkError]);

      t.connect();
      await t.advance();
      t.userSays("first");
      t.agentSays("second");
      t.userSays("third");
      await t.advance(120_000);

      expect(t.server.acknowledgedEntries.map((e) => (e.kind === "line" ? e.text : null))).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    it("retries a 5xx answer with the same entries", async () => {
      const t = setup([ok, status(503)]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance(120_000);

      const entryRequests = t.server.entryRequests();
      expect(entryRequests).toHaveLength(2);
      expect(entryRequests[1].body).toEqual(entryRequests[0].body);
      expect(t.outcomes).toEqual([]);
    });

    it("retries a 5xx answer to the open request before sending any line", async () => {
      const t = setup([status(500)]);

      t.connect();
      t.userSays("Hello there");
      await t.advance(120_000);

      expect(t.server.openRequests().length).toBe(2);
      expect(t.server.requests[1].url).toBe(`${HISTORY_URL}/conversations`);
      expect(t.server.requests[2].url).toBe(
        `${HISTORY_URL}/conversations/${CONVERSATION_ID}/entries`,
      );
      expect(t.outcomes).toEqual([]);
    });

    it("never waits more than 30 s between attempts, however many have failed", async () => {
      const t = setup(Array.from({ length: 60 }, () => networkError));

      t.connect();
      await t.advance();

      // A cap that is missing shows up as a 30 s step with no new attempt in it.
      const attemptsPerStep: number[] = [];
      for (let step = 0; step < 30; step++) {
        const before = t.server.requests.length;
        await t.advance(30_000);
        attemptsPerStep.push(t.server.requests.length - before);
      }

      expect(attemptsPerStep.every((attempts) => attempts >= 1)).toBe(true);
      const sentAt = t.server.requests.map((r) => r.sentAtMs);
      const gaps = sentAt.slice(1).map((at, i) => at - sentAt[i]);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
    });

    it("waits between attempts rather than retrying in a tight loop", async () => {
      const t = setup(Array.from({ length: 60 }, () => networkError));

      t.connect();
      await t.advance(0);

      expect(t.server.requests).toHaveLength(1);
    });
  });

  describe("a refusal (4xx)", () => {
    it("reports notSaved at once when the open request is refused", async () => {
      const t = setup([status(403)]);

      t.connect();
      await t.advance();

      expect(t.outcomes).toEqual([{ outcome: "notSaved", summary: null }]);
    });

    it("reports notSaved at once when an entries request is refused mid-conversation", async () => {
      const t = setup([ok, status(400)]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance();

      expect(t.outcomes).toEqual([{ outcome: "notSaved", summary: null }]);
    });

    it("sends no further request when more lines, turns and the end arrive after it", async () => {
      const t = setup([ok, status(400)]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance();
      const requestsAtRefusal = t.server.requests.length;

      t.userSays("Anyone there?");
      t.agentSays("Yes");
      t.stream.addTurn(metrics);
      t.stream.end("user");
      await t.advance(120_000);

      expect(t.server.requests).toHaveLength(requestsAtRefusal);
      expect(t.outcomes).toHaveLength(1);
    });

    it("does not retry the refused request", async () => {
      const t = setup([status(404)]);

      t.connect();
      await t.advance(120_000);

      expect(t.server.requests).toHaveLength(1);
    });
  });

  describe("after end()", () => {
    it("reports saved with the length, who ended it and the message once the queue is drained", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      t.clock.nowMs = START_MS + 408_000;
      t.stream.end("error", "connection dropped");
      await t.advance();

      expect(t.outcomes).toEqual([
        {
          outcome: "saved",
          summary: { lengthMs: 408_000, endedBy: "error", message: "connection dropped" },
        },
      ]);
    });

    it("measures the length as end minus start on the injected clock", async () => {
      const t = setup();

      t.clock.nowMs = 50_000;
      t.connect();
      await t.advance();
      t.clock.nowMs = 50_000 + 12_345;
      t.stream.end("agent");
      await t.advance();

      expect(t.outcomes).toHaveLength(1);
      expect(t.outcomes[0].summary).toEqual({ lengthMs: 12_345, endedBy: "agent" });
    });

    it("sends the end entry carrying who ended the conversation", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();

      expect(t.server.sentEntries()).toEqual([{ kind: "end", endedBy: "user", segment: 1 }]);
    });

    it("reports nothing before the end() call, even with everything acknowledged", async () => {
      const t = setup();

      t.connect();
      t.userSays("Hello there");
      await t.advance(60_000);

      expect(t.outcomes).toEqual([]);
    });

    it("waits for the end entry to be acknowledged before reporting saved", async () => {
      const endAnswer = heldAnswer();
      const t = setup([ok, endAnswer.answer]);

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance(5_000);
      expect(t.outcomes).toEqual([]);

      endAnswer.release();
      await t.advance();

      expect(t.outcomes.map((o) => o.outcome)).toEqual(["saved"]);
    });

    it("reports notSaved when entries are still unacknowledged 15 s after the end, and not before", async () => {
      const t = setup(Array.from({ length: 60 }, () => networkError));

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      t.stream.end("user");

      await t.advance(14_999);
      expect(t.outcomes).toEqual([]);

      await t.advance(1);
      expect(t.outcomes.map((o) => o.outcome)).toEqual(["notSaved"]);
    });

    it("counts the 15 s from the end, not from the start of the conversation", async () => {
      const t = setup(Array.from({ length: 60 }, () => networkError));

      t.connect();
      await t.advance(100_000);
      expect(t.outcomes).toEqual([]);
      t.stream.end("user");

      await t.advance(14_999);
      expect(t.outcomes).toEqual([]);
      await t.advance(1);

      expect(t.outcomes.map((o) => o.outcome)).toEqual(["notSaved"]);
    });

    it("reports saved, and no notSaved later, when the last acknowledgement arrives just inside 15 s", async () => {
      const endAnswer = heldAnswer();
      const t = setup([ok, endAnswer.answer]);

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance(14_000);
      endAnswer.release();
      await t.advance();
      expect(t.outcomes.map((o) => o.outcome)).toEqual(["saved"]);

      await t.advance(60_000);

      expect(t.outcomes.map((o) => o.outcome)).toEqual(["saved"]);
    });

    it("reports an outcome once even when the server stays down after notSaved", async () => {
      const t = setup(Array.from({ length: 200 }, () => networkError));

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance(120_000);

      expect(t.outcomes).toHaveLength(1);
    });
  });

  describe("end() twice", () => {
    it("sends one end entry and reports one outcome", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.stream.end("user");
      t.stream.end("agent", "second ending");
      await t.advance(60_000);

      const endEntries = t.server.sentEntries().filter((e) => e.kind === "end");
      expect(endEntries).toEqual([{ kind: "end", endedBy: "user", segment: 1 }]);
      expect(t.outcomes).toHaveLength(1);
      expect(t.outcomes[0].summary?.endedBy).toBe("user");
    });

    it("ignores a second end() called after the outcome was already reported", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();
      expect(t.outcomes).toHaveLength(1);
      const requestsBefore = t.server.requests.length;

      t.stream.end("error", "late");
      await t.advance(60_000);

      expect(t.server.requests).toHaveLength(requestsBefore);
      expect(t.outcomes).toHaveLength(1);
    });
  });

  describe("one request at a time", () => {
    it("keeps at most one request in flight and sends what queued meanwhile together in the next one", async () => {
      const firstEntries = heldAnswer();
      const t = setup([ok, firstEntries.answer]);

      t.connect();
      await t.advance();
      t.userSays("one");
      await t.advance();
      t.agentSays("two");
      t.userSays("three");
      await t.advance(1_000);

      expect(t.server.entryRequests()).toHaveLength(1);
      expect(t.server.maxInFlight).toBe(1);

      firstEntries.release();
      await t.advance();

      const entryRequests = t.server.entryRequests();
      expect(entryRequests).toHaveLength(2);
      expect(entryRequests[1].body.entries).toEqual([
        { kind: "line", seq: 2, speaker: "agent", text: "two", atMs: 0 },
        { kind: "line", seq: 3, speaker: "user", text: "three", atMs: 0 },
      ]);
      expect(t.server.maxInFlight).toBe(1);
    });

    it("holds lines said while the open request is in flight and sends them together after it", async () => {
      const openAnswer = heldAnswer();
      const t = setup([openAnswer.answer]);

      t.connect();
      t.userSays("one");
      t.agentSays("two");
      t.userSays("three");
      await t.advance(1_000);

      expect(t.server.requests).toHaveLength(1);

      openAnswer.release();
      await t.advance();

      expect(t.server.requests).toHaveLength(2);
      expect(t.server.requests[1].body.entries?.map((e) => (e.kind === "line" ? e.seq : null))).toEqual(
        [1, 2, 3],
      );
      expect(t.server.maxInFlight).toBe(1);
    });

    it("sends at most 50 entries per request, in order, and loses none", async () => {
      const openAnswer = heldAnswer();
      const t = setup([openAnswer.answer]);

      t.connect();
      for (let line = 1; line <= 120; line++) t.userSays(`line ${line}`);
      openAnswer.release();
      await t.advance(1_000);

      const batches = t.server.entryRequests().map((r) => r.body.entries ?? []);
      expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
      expect(t.server.sentEntries().map((e) => (e.kind === "line" ? e.seq : null))).toEqual(
        Array.from({ length: 120 }, (_, i) => i + 1),
      );
      expect(t.server.maxInFlight).toBe(1);
    });
  });

  describe("turns", () => {
    it("numbers turns separately from lines, each from 1", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      t.stream.addTurn(metrics);
      t.agentSays("Hi");
      t.stream.addTurn({ ...metrics, totalMs: 1800 });
      t.userSays("Bye");
      await t.advance();

      const entries = t.server.sentEntries();
      expect(entries.filter((e) => e.kind === "line").map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(entries.filter((e) => e.kind === "turn").map((e) => e.seq)).toEqual([1, 2]);
    });

    it("sends the turn's metrics untouched, stamped with the time since the start", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.clock.nowMs = START_MS + 3_000;
      t.stream.addTurn(metrics);
      await t.advance();

      expect(t.server.sentEntries()).toEqual([{ kind: "turn", seq: 1, atMs: 3_000, metrics }]);
    });

    it("sends no turn that completes while the end entry is still being delivered", async () => {
      const endAnswer = heldAnswer();
      const t = setup([ok, endAnswer.answer]);

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();
      t.stream.addTurn(metrics);
      endAnswer.release();
      await t.advance(60_000);

      expect(t.server.sentEntries().filter((e) => e.kind === "turn")).toEqual([]);
    });

    it("sends no turn after the conversation ended", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();
      t.stream.addTurn(metrics);
      await t.advance(60_000);

      expect(t.server.sentEntries().filter((e) => e.kind === "turn")).toEqual([]);
    });
  });

  describe("flushOnPageHide", () => {
    it("sends the queued entries with keepalive once the open request was acknowledged", async () => {
      const t = setup([ok, networkError]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance();
      // The line is now waiting for its retry.
      const requestsBeforeHide = t.server.requests.length;

      t.stream.flushOnPageHide();
      await t.advance();

      const flush = t.server.requests[requestsBeforeHide];
      expect(flush.keepalive).toBe(true);
      expect(flush.url).toBe(`${HISTORY_URL}/conversations/${CONVERSATION_ID}/entries`);
      expect(flush.userHeader).toBe(USER_ID);
      expect(flush.body.entries).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "Hello there", atMs: 0 },
        { kind: "end", endedBy: "closed", segment: 1 },
      ]);
    });

    it("sends nothing while the open request is not yet acknowledged", async () => {
      const openAnswer = heldAnswer();
      const t = setup([openAnswer.answer]);

      t.connect();
      t.userSays("Hello there");
      await t.advance();

      t.stream.flushOnPageHide();
      await t.advance();

      expect(t.server.requests).toHaveLength(1);
      expect(t.server.requests.some((r) => r.keepalive === true)).toBe(false);
    });

    it("sends only the closing end when nothing else is queued", async () => {
      const t = setup();

      t.connect();
      await t.advance();

      t.stream.flushOnPageHide();
      await t.advance();

      const keepalive = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepalive).toHaveLength(1);
      expect(keepalive[0].body.entries).toEqual([{ kind: "end", endedBy: "closed", segment: 1 }]);
    });

    it("sends nothing when the queue is empty after the conversation was saved", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();
      const requestsBeforeHide = t.server.requests.length;

      t.stream.flushOnPageHide();
      await t.advance();

      expect(t.server.requests).toHaveLength(requestsBeforeHide);
    });

    it("sends nothing after the server refused the conversation", async () => {
      const t = setup([ok, status(400)]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance();
      const requestsAtRefusal = t.server.requests.length;

      t.stream.flushOnPageHide();
      await t.advance();

      expect(t.server.requests).toHaveLength(requestsAtRefusal);
    });

    it("keeps keepalive off the ordinary requests", async () => {
      const t = setup();

      t.connect();
      t.userSays("Hello there");
      t.stream.end("user");
      await t.advance();

      expect(t.server.requests.length).toBeGreaterThanOrEqual(2);
      expect(t.server.requests.some((r) => r.keepalive === true)).toBe(false);
    });
  });

  describe("a server that comes back just before the end", () => {
    it("receives every line and the ending within 15 s of the end and the conversation is saved", async () => {
      // Down for the first 40 s: the backoff has grown to 30 s, so the next retry is not due until 61 s.
      const t = setup(Array.from({ length: 500 }, () => downUntil(40_000)));

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance(20_000);
      t.agentSays("Hi, how can I help?");
      await t.advance(21_000);
      expect(t.server.acknowledgedEntries).toEqual([]);

      t.stream.end("user");
      await t.advance(14_000);

      expect(t.server.acknowledgedEntries).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "Hello there", atMs: 0 },
        { kind: "line", seq: 2, speaker: "agent", text: "Hi, how can I help?", atMs: 0 },
        { kind: "end", endedBy: "user", segment: 1 },
      ]);
      expect(t.outcomes.map((o) => o.outcome)).toEqual(["saved"]);
    });
  });

  describe("a server that accepts the request and never answers", () => {
    it("is sent the same entries again after 10 s, and they count as stored once it answers", async () => {
      const t = setup([ok, neverAnswers]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance(9_999);
      expect(t.server.entryRequests()).toHaveLength(1);

      await t.advance(1_001);

      const entryRequests = t.server.entryRequests();
      expect(entryRequests).toHaveLength(2);
      expect(entryRequests[1].body).toEqual(entryRequests[0].body);
      expect(entryRequests[1].body.entries).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "Hello there", atMs: 0 },
      ]);
      expect(t.server.acknowledgedEntries).toEqual(entryRequests[1].body.entries);
    });
  });

  describe("an over-long line", () => {
    it("is sent as its first 4000 characters, and the later lines and the ending still go out", async () => {
      const t = setup();
      const reply = "a".repeat(4_000) + "b".repeat(500);

      t.connect();
      await t.advance();
      t.agentSays(reply);
      t.userSays("And then?");
      t.stream.end("agent");
      await t.advance();

      expect(t.server.acknowledgedEntries).toEqual([
        { kind: "line", seq: 1, speaker: "agent", text: "a".repeat(4_000), atMs: 0 },
        { kind: "line", seq: 2, speaker: "user", text: "And then?", atMs: 0 },
        { kind: "end", endedBy: "agent", segment: 1 },
      ]);
      expect(t.outcomes.map((o) => o.outcome)).toEqual(["saved"]);
    });
  });

  describe("an over-long error message", () => {
    it("is sent as its first 500 characters", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.stream.end("error", "m".repeat(500) + "n".repeat(100));
      await t.advance();

      expect(t.server.sentEntries()).toEqual([{ kind: "end", endedBy: "error", segment: 1, message: "m".repeat(500) }]);
      expect(t.outcomes.map((o) => o.outcome)).toEqual(["saved"]);
    });
  });

  describe("flushOnPageHide with a long queue", () => {
    it("sends one keepalive request of at most 64 KiB carrying the oldest lines, in order", async () => {
      const t = setup([ok, networkError]);

      t.connect();
      await t.advance();
      // The first line fails and waits for its retry; the rest queue up behind it.
      for (let line = 1; line <= 50; line++) t.userSays(String(line).padStart(2, "0") + "x".repeat(3_998));
      await t.advance();

      t.stream.flushOnPageHide();
      await t.advance();

      const keepaliveRequests = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepaliveRequests).toHaveLength(1);
      expect(keepaliveRequests[0].bodyBytes).toBeLessThanOrEqual(64 * 1024);
      const carried = keepaliveRequests[0].body.entries ?? [];
      expect(carried.length).toBeGreaterThan(1);
      expect(carried.length).toBeLessThan(50);
      const lines = carried.slice(0, -1);
      expect(lines.map((e) => (e.kind === "line" ? e.seq : null))).toEqual(
        Array.from({ length: lines.length }, (_, i) => i + 1),
      );
    });

    it("always carries the closed ending, even when lines are left behind", async () => {
      const t = setup([ok, networkError]);

      t.connect();
      await t.advance();
      for (let line = 1; line <= 60; line++) t.userSays(`line ${line}`);
      await t.advance();

      t.stream.flushOnPageHide();
      await t.advance();

      const carried = t.server.requests.find((r) => r.keepalive === true)?.body.entries ?? [];
      expect(carried).toHaveLength(50);
      expect(carried.at(-1)).toEqual({ kind: "end", endedBy: "closed", segment: 1 });
    });
  });

  describe("end() while a request is in flight", () => {
    it("starts the backoff over, so the retry still fits the 15 s the ending has", async () => {
      // Attempts 0-4 of the line never answer; the fifth is in flight at 55 s, when the backoff has grown to 16 s.
      const t = setup([ok, ...Array.from({ length: 5 }, () => neverAnswers)]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance(56_000);
      expect(t.server.entryRequests()).toHaveLength(5);

      t.stream.end("user");
      await t.advance(15_000);

      expect(t.outcomes.map((o) => o.outcome)).toEqual(["saved"]);
    });
  });

  describe("more lines than the server keeps", () => {
    it("queues none past the cap, and the turns and the ending still go out", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      for (let line = 1; line <= 2_001; line++) t.userSays(`line ${line}`);
      t.stream.addTurn(metrics);
      t.stream.end("user");
      await t.advance();

      const sent = t.server.sentEntries();
      const lineSeqs = sent.flatMap((e) => (e.kind === "line" ? [e.seq] : []));
      expect(lineSeqs).toHaveLength(2_000);
      expect(lineSeqs).not.toContain(2_001);
      expect(sent.filter((e) => e.kind === "turn")).toHaveLength(1);
      expect(sent.at(-1)).toEqual({ kind: "end", endedBy: "user", segment: 1 });
      expect(t.outcomes.map((o) => o.outcome)).toEqual(["saved"]);
    });
  });

  describe("flushOnPageHide with a budget", () => {
    it("sends only the head entries that fit it and returns the bytes of that request", async () => {
      const t = setup([ok, networkError]);

      t.connect();
      await t.advance();
      for (let line = 1; line <= 5; line++) t.userSays("x".repeat(1_000));
      await t.advance();

      const used = t.stream.flushOnPageHide(2_500);
      await t.advance();

      const keepaliveRequests = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepaliveRequests).toHaveLength(1);
      expect(keepaliveRequests[0].body.entries?.map((e) => (e.kind === "line" ? e.seq : e.kind))).toEqual([1, 2, "end"]);
      expect(used).toBe(keepaliveRequests[0].bodyBytes);
      expect(used).toBeLessThanOrEqual(2_500);
    });

    it("sends only the ending when no line fits beside it", async () => {
      const t = setup([ok, networkError]);

      t.connect();
      await t.advance();
      t.userSays("x".repeat(1_000));
      await t.advance();

      t.stream.flushOnPageHide(500);
      await t.advance();

      const keepalive = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepalive.map((r) => r.body.entries)).toEqual([[{ kind: "end", endedBy: "closed", segment: 1 }]]);
    });

    it("sends nothing and returns 0 when not even the ending fits", async () => {
      const t = setup([ok, networkError]);

      t.connect();
      await t.advance();
      t.userSays("x".repeat(1_000));
      await t.advance();

      const used = t.stream.flushOnPageHide(20);
      await t.advance();

      expect(used).toBe(0);
      expect(t.server.requests.some((r) => r.keepalive === true)).toBe(false);
    });
  });

  describe("the reason for notSaved", () => {
    it("is refused when the server answers with a 4xx", async () => {
      const t = setup([ok, status(400)]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance();

      expect(t.statuses).toEqual([{ kind: "recording" }, { kind: "notSaved", reason: "refused" }]);
    });

    it("is unreachable when the entries are still unacknowledged 15 s after the end", async () => {
      const t = setup(Array.from({ length: 60 }, () => networkError));

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      t.stream.end("user");
      await t.advance(15_000);

      expect(t.statuses).toEqual([
        { kind: "recording" },
        { kind: "saving" },
        { kind: "notSaved", reason: "unreachable" },
      ]);
    });
  });

  describe("a Start after an ending", () => {
    // Server rule imitated by the default answer: "POST /conversations ... same user again 200".
    it("continues the same conversation: open, then resume, the same id, seq and time still counting", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.userSays("first segment");
      t.stream.addTurn(metrics);
      t.clock.nowMs = START_MS + 10_000;
      t.stream.end("user");
      await t.advance();
      t.clock.nowMs = START_MS + 30_000;
      t.connect("conv_a_different_id");
      await t.advance();
      t.agentSays("second segment");
      t.stream.addTurn(metrics);
      await t.advance();

      expect(t.server.openRequests().map((r) => r.body)).toEqual([
        { conversationId: CONVERSATION_ID, agentId: AGENT_ID },
        { conversationId: CONVERSATION_ID, agentId: AGENT_ID },
      ]);
      expect(t.server.requests.every((r) => !r.url.includes("a_different_id"))).toBe(true);
      const resumeRequest = t.server.requests.findIndex((r) => r.body.entries?.some((e) => e.kind === "resume"));
      const secondOpenRequest = t.server.requests.indexOf(t.server.openRequests()[1]);
      expect(secondOpenRequest).toBeLessThan(resumeRequest);
      expect(t.server.sentEntries()).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "first segment", atMs: 0 },
        { kind: "turn", seq: 1, atMs: 0, metrics },
        { kind: "end", endedBy: "user", segment: 1 },
        { kind: "resume", segment: 2 },
        { kind: "line", seq: 2, speaker: "agent", text: "second segment", atMs: 30_000 },
        { kind: "turn", seq: 2, atMs: 30_000, metrics },
      ]);
    });

    it("reports recording on the open and again on the resume", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();
      t.connect();
      await t.advance();

      expect(t.statuses).toEqual([
        { kind: "recording" },
        { kind: "saving" },
        { kind: "saved", summary: { lengthMs: 0, endedBy: "user" } },
        { kind: "recording" },
      ]);
    });

    it("ends the second segment with segment 2", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();
      t.connect();
      await t.advance();
      t.stream.end("agent");
      await t.advance();

      expect(t.server.sentEntries().filter((e) => e.kind === "end")).toEqual([
        { kind: "end", endedBy: "user", segment: 1 },
        { kind: "end", endedBy: "agent", segment: 2 },
      ]);
    });

    it("reports a saved summary whose length runs from the first Start to the latest ending", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.clock.nowMs = START_MS + 10_000;
      t.stream.end("user");
      await t.advance();
      t.clock.nowMs = START_MS + 60_000;
      t.connect();
      await t.advance();
      t.clock.nowMs = START_MS + 75_000;
      t.stream.end("agent");
      await t.advance();

      expect(t.outcomes.map((o) => o.summary)).toEqual([
        { lengthMs: 10_000, endedBy: "user" },
        { lengthMs: 75_000, endedBy: "agent" },
      ]);
    });

    it("sends again once the server answers after the first ending was given up on as unreachable", async () => {
      // The server is down from the first line until 16 s on the fake timers, past the ending's 15 s.
      const t = setup([ok, ...Array.from({ length: 60 }, () => downUntil(16_000))]);

      t.connect();
      await t.advance();
      t.userSays("lost while the server was down");
      t.stream.end("user");
      await t.advance(15_000);
      expect(t.statuses.at(-1)).toEqual({ kind: "notSaved", reason: "unreachable" });
      await t.advance(1_000);
      expect(t.server.acknowledgedEntries).toEqual([]);

      t.clock.nowMs = START_MS + 16_000;
      t.connect();
      t.userSays("said after the server came back");
      t.stream.end("user");
      await t.advance();

      expect(t.server.openRequests().at(-1)?.body).toEqual({ conversationId: CONVERSATION_ID, agentId: AGENT_ID });
      expect(t.server.acknowledgedEntries).toEqual([
        { kind: "resume", segment: 2 },
        { kind: "line", seq: 2, speaker: "user", text: "said after the server came back", atMs: 16_000 },
        { kind: "end", endedBy: "user", segment: 2 },
      ]);
      expect(t.statuses.at(-1)).toMatchObject({ kind: "saved" });
    });

    it("resumes from draining: the drain timer is cancelled and the unsent ending still goes out first", async () => {
      const t = setup([ok, ...Array.from({ length: 4 }, () => networkError)]);

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance(5_000);
      t.connect();
      // Past the 15 s the first ending had: it must not report notSaved any more.
      await t.advance(30_000);

      expect(t.statuses.some((s) => s.kind === "notSaved")).toBe(false);
      expect(t.server.acknowledgedEntries).toEqual([
        { kind: "end", endedBy: "user", segment: 1 },
        { kind: "resume", segment: 2 },
      ]);
    });

    it("is ignored after the server refused the conversation", async () => {
      const t = setup([status(403)]);

      t.connect();
      await t.advance();
      const requestsAtRefusal = t.server.requests.length;

      t.connect();
      t.userSays("Hello there");
      t.stream.end("user");
      await t.advance(60_000);

      expect(t.server.requests).toHaveLength(requestsAtRefusal);
      expect(t.statuses).toEqual([{ kind: "recording" }, { kind: "notSaved", reason: "refused" }]);
    });

    it("is ignored while a segment is still running", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      t.connect();
      await t.advance();

      expect(t.server.requests).toHaveLength(1);
      expect(t.statuses).toEqual([{ kind: "recording" }]);
    });
  });

  describe("flushOnPageHide during a segment", () => {
    it("ends a running segment as closed with keepalive, carrying the segment number", async () => {
      const t = setup([ok, networkError]);

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();
      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance();
      const requestsBeforeHide = t.server.requests.length;

      t.stream.flushOnPageHide();
      await t.advance();

      const keepalive = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepalive).toHaveLength(1);
      expect(t.server.requests.indexOf(keepalive[0])).toBe(requestsBeforeHide);
      expect(keepalive[0].body.entries?.at(-1)).toEqual({ kind: "end", endedBy: "closed", segment: 2 });
    });

    it("does not wait for a resumed segment's open: its lines and closed ending still go", async () => {
      const reopen = heldAnswer();
      // open, end{1}, then the re-open of segment 2 stays in flight.
      const t = setup([ok, ok, reopen.answer]);

      t.connect();
      await t.advance();
      t.stream.end("user");
      await t.advance();
      t.connect();
      t.userSays("still talking");
      await t.advance();

      t.stream.flushOnPageHide();
      await t.advance();

      const keepalive = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepalive.map((r) => r.body.entries)).toEqual([
        [
          { kind: "resume", segment: 2 },
          { kind: "line", seq: 1, speaker: "user", text: "still talking", atMs: 0 },
          { kind: "end", endedBy: "closed", segment: 2 },
        ],
      ]);
    });

    it("adds no ending while draining, where one is already queued", async () => {
      const t = setup([ok, ...Array.from({ length: 60 }, () => networkError)]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      t.stream.end("user");
      await t.advance(2_000);

      t.stream.flushOnPageHide();
      await t.advance();

      const keepalive = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepalive).toHaveLength(1);
      expect(keepalive[0].body.entries?.filter((e) => e.kind === "end")).toEqual([
        { kind: "end", endedBy: "user", segment: 1 },
      ]);
    });

    it("adds no ending after the conversation was refused", async () => {
      const t = setup([ok, status(400)]);

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      await t.advance();
      const requestsAtRefusal = t.server.requests.length;

      t.stream.flushOnPageHide();
      await t.advance();

      expect(t.server.requests).toHaveLength(requestsAtRefusal);
    });
  });

  describe("dispose()", () => {
    it("while open stops all sending and reporting, whatever arrives afterwards", async () => {
      const t = setup();

      t.connect();
      await t.advance();
      const requestsBeforeDispose = t.server.requests.length;

      t.stream.dispose();
      t.userSays("Hello there");
      t.stream.addTurn(metrics);
      t.stream.end("user");
      await t.advance(60_000);

      expect(t.server.requests).toHaveLength(requestsBeforeDispose);
      expect(t.statuses).toEqual([{ kind: "recording" }]);
    });

    it("while draining with a retry waiting sends nothing more and never reports notSaved", async () => {
      const t = setup(Array.from({ length: 200 }, () => networkError));

      t.connect();
      await t.advance();
      t.userSays("Hello there");
      t.stream.end("user");
      await t.advance(2_000);
      expect(t.statuses).toEqual([{ kind: "recording" }, { kind: "saving" }]);
      const requestsBeforeDispose = t.server.requests.length;

      t.stream.dispose();
      await t.advance(60_000);

      expect(t.server.requests).toHaveLength(requestsBeforeDispose);
      expect(t.statuses).toEqual([{ kind: "recording" }, { kind: "saving" }]);
    });
  });
});
