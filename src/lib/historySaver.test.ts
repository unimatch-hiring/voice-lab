import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./events";
import type { HistoryEntry } from "./history";
import { HistorySaver, type SaveLine } from "./historySaver";

const HISTORY_URL = "http://history.test";
const USER_ID = "3f2b8c1e-7d4a-4e5b-9a6c-1d2e3f4a5b6c";

/** A history server that is up, down or refusing as the test says, and remembers what it accepted. */
function createFakeServer() {
  const state = { up: true, entriesUp: true, refuseOpen: false };
  const openedIds: string[] = [];
  const acceptedEntries: Record<string, HistoryEntry[]> = {};
  /** Every request, answered or not, so a test can see what was sent while the server was failing. */
  const requests: { conversationId: string | null; keepalive: boolean | undefined; entries: HistoryEntry[] }[] = [];

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const entriesPath = /\/conversations\/([^/]+)\/entries$/.exec(String(input));
    const body = JSON.parse(String(init?.body));
    requests.push({ conversationId: entriesPath?.[1] ?? null, keepalive: init?.keepalive, entries: body.entries ?? [] });
    if (!state.up || (entriesPath && !state.entriesUp)) throw new TypeError("Failed to fetch");
    if (entriesPath) {
      (acceptedEntries[entriesPath[1]] ??= []).push(...body.entries);
    } else {
      // README: opening a conversation the user is not allowed to is 403 — the stream treats any 4xx as a refusal.
      if (state.refuseOpen) return new Response("{}", { status: 403 });
      openedIds.push(body.conversationId);
    }
    return new Response("{}", { status: 200 });
  };

  return {
    fetch: fakeFetch as typeof fetch,
    openedIds,
    acceptedEntries,
    requests,
    goDown: () => {
      state.up = false;
    },
    /** Opening a conversation still works; only the entries requests fail. */
    breakEntries: () => {
      state.entriesUp = false;
    },
    comeBack: () => {
      state.up = true;
    },
    refuseOpen: () => {
      state.refuseOpen = true;
    },
  };
}

function setup() {
  const bus = new EventBus();
  const server = createFakeServer();
  const reports: SaveLine[][] = [];
  const saver = new HistorySaver({
    bus,
    historyUrl: HISTORY_URL,
    userId: USER_ID,
    fetch: server.fetch,
    now: () => Date.now(),
    onLines: (lines) => reports.push(lines),
  });

  return {
    saver,
    server,
    reports,
    lastLines: () => reports.at(-1),
    connect: (conversationId: string) =>
      bus.emit({ type: "conversation-start", conversationId, agentId: "agent_xyz", at: Date.now() }),
    userSays: (text: string) => bus.emit({ type: "stt-result", result: { text, words: [] } }),
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

describe("HistorySaver", () => {
  describe("End followed by Start on the same page", () => {
    it("continues one conversation: one id opened, a resume for the second segment, one line", async () => {
      const t = setup();

      t.saver.start();
      t.connect("conv_a");
      await t.advance();
      t.userSays("first segment");
      t.saver.end("user");
      await t.advance();
      expect(t.lastLines()).toEqual([{ key: 0, status: expect.objectContaining({ kind: "saved" }) }]);

      t.saver.start();
      t.connect("conv_b");
      await t.advance();
      t.userSays("second segment");
      t.saver.end("agent");
      await t.advance();

      // The stream opens again before a resume (the server answers 200 for an id it has), always with the first Start's id.
      expect(new Set(t.server.openedIds)).toEqual(new Set(["conv_a"]));
      expect(t.server.acceptedEntries["conv_b"]).toBeUndefined();
      expect(t.server.acceptedEntries["conv_a"]).toEqual([
        { kind: "line", seq: 1, speaker: "user", text: "first segment", atMs: 0 },
        { kind: "end", endedBy: "user", segment: 1 },
        { kind: "resume", segment: 2 },
        { kind: "line", seq: 2, speaker: "user", text: "second segment", atMs: 0 },
        { kind: "end", endedBy: "agent", segment: 2 },
      ]);
      expect(t.lastLines()).toEqual([{ key: 0, status: expect.objectContaining({ kind: "saved" }) }]);
    });

    it("reports the running second segment as recording, which the page shows as no line", async () => {
      const t = setup();

      t.saver.start();
      t.connect("conv_a");
      await t.advance();
      t.saver.end("user");
      await t.advance();
      t.saver.start();
      t.connect("conv_b");

      expect(t.lastLines()).toEqual([{ key: 0, status: { kind: "recording" } }]);
    });

    it("continues the conversation too when the server was unreachable for the first ending", async () => {
      const t = setup();

      t.server.goDown();
      t.saver.start();
      t.connect("conv_a");
      t.saver.end("user");
      await t.advance(15_000);
      expect(t.lastLines()).toEqual([{ key: 0, status: { kind: "notSaved", reason: "unreachable" } }]);

      t.server.comeBack();
      t.saver.start();
      t.connect("conv_b");
      await t.advance();

      expect(t.server.openedIds).toEqual(["conv_a"]);
      expect(t.server.acceptedEntries["conv_a"]).toEqual([{ kind: "resume", segment: 2 }]);
    });
  });

  describe("a Start after the server refused the conversation", () => {
    it("is a new conversation with its own id and its own line", async () => {
      const t = setup();

      t.server.refuseOpen();
      t.saver.start();
      t.connect("conv_a");
      await t.advance();
      expect(t.lastLines()).toEqual([{ key: 0, status: { kind: "notSaved", reason: "refused" } }]);

      t.saver.start();
      expect(t.lastLines()).toEqual([]);
      t.connect("conv_b");
      await t.advance();

      expect(t.server.requests.filter((r) => r.conversationId === null)).toHaveLength(2);
      expect(t.lastLines()).toEqual([{ key: 1, status: { kind: "notSaved", reason: "refused" } }]);
    });
  });

  describe("a Start before any conversation connected", () => {
    it("keeps the same stream, so the conversation that does connect is recorded once", async () => {
      const t = setup();

      t.saver.start();
      t.saver.start();
      t.connect("conv_a");
      await t.advance();

      expect(t.server.openedIds).toEqual(["conv_a"]);
    });
  });

  describe("flushOnPageHide", () => {
    it("during a running segment sends one keepalive request that carries the closed ending", async () => {
      const t = setup();

      t.saver.start();
      t.connect("conv_a");
      await t.advance();

      t.saver.flushOnPageHide();

      const keepaliveRequests = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepaliveRequests).toHaveLength(1);
      expect(keepaliveRequests[0].conversationId).toBe("conv_a");
      expect(keepaliveRequests[0].entries).toEqual([{ kind: "end", endedBy: "closed", segment: 1 }]);
    });

    it("gives the stream the whole 64 KiB budget, so ten 4000-character lines go in one request", async () => {
      const t = setup();

      t.saver.start();
      t.connect("conv_a");
      await t.advance();
      t.server.breakEntries();
      for (let line = 0; line < 10; line++) t.userSays("a".repeat(4_000));
      await t.advance(500);

      t.saver.flushOnPageHide();

      const keepaliveRequests = t.server.requests.filter((r) => r.keepalive === true);
      expect(keepaliveRequests).toHaveLength(1);
      expect(keepaliveRequests[0].entries).toHaveLength(11);
    });

    it("sends nothing when no segment is running", async () => {
      const t = setup();

      t.saver.start();
      t.connect("conv_a");
      await t.advance();
      t.saver.end("user");
      await t.advance();
      const requestsBefore = t.server.requests.length;

      t.saver.flushOnPageHide();

      expect(t.server.requests).toHaveLength(requestsBefore);
    });
  });

  describe("dispose()", () => {
    it("while the stream waits to retry sends nothing more and reports nothing more", async () => {
      const t = setup();

      t.saver.start();
      t.connect("conv_a");
      await t.advance();
      t.server.breakEntries();
      t.userSays("line of A");
      t.saver.end("user");
      await t.advance(500);
      expect(t.lastLines()).toEqual([{ key: 0, status: { kind: "saving" } }]);
      const requestsBeforeDispose = t.server.requests.length;
      const reportsBeforeDispose = t.reports.length;

      t.saver.dispose();
      await t.advance(60_000);

      expect(t.server.requests).toHaveLength(requestsBeforeDispose);
      expect(t.reports).toHaveLength(reportsBeforeDispose);
    });
  });
});
