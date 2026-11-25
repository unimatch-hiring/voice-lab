import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_LINES_PER_CONVERSATION } from "../shared/historyContract.js";
import { ConversationStore, IN_PROGRESS_WINDOW_MS } from "./store.js";

const ALICE = "alice-hash";
const BOB = "bob-hash";
const AGENT = "agent-1";

const line = (seq, text = `line ${seq}`) => ({
  kind: "line", seq, speaker: seq % 2 ? "user" : "agent", text, atMs: seq * 100,
});
const turn = (seq, stages = { stt: 120, llm: 300 }) => ({
  kind: "turn", seq, atMs: seq * 1000,
  metrics: { stages, totalMs: 900, llmTokens: 42, ttsChars: 180 },
});
const end = (endedBy, message, segment = 1) => ({
  kind: "end", endedBy, segment, ...(message && { message }),
});
const resume = (segment) => ({ kind: "resume", segment });

let db;
let clock;
let store;

const tick = () => (clock += 10);
const open = (conversationId, userHash = ALICE) =>
  store.open({ userHash, conversationId, agentId: AGENT });
const append = (conversationId, entries, userHash = ALICE) =>
  store.append({ userHash, conversationId, entries });
const read = (conversationId) =>
  store.get({ userHash: ALICE, conversationId }).conversation;
const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  clock = 1_000;
  store = new ConversationStore(db, () => clock);
});

describe("database settings", () => {
  it("uses the write-ahead log and waits 2 s on a lock, on a file database", () => {
    const directory = mkdtempSync(join(tmpdir(), "history-store-"));
    const fileDb = new DatabaseSync(join(directory, "history.sqlite"));
    try {
      new ConversationStore(fileDb);
      expect(fileDb.prepare("PRAGMA journal_mode").get().journal_mode).toBe("wal");
      expect(fileDb.prepare("PRAGMA busy_timeout").get().timeout).toBe(2000);
    } finally {
      fileDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds the segment column to a file made by the schema without it, keeping its rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "history-store-"));
    const path = join(directory, "history.sqlite");
    const oldDb = new DatabaseSync(path);
    oldDb.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, user_hash TEXT NOT NULL, agent_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, last_entry_at INTEGER NOT NULL,
      ended_at INTEGER, ended_by TEXT, end_message TEXT
    ) STRICT`);
    oldDb.prepare(
      "INSERT INTO conversations (id, user_hash, agent_id, started_at, last_entry_at) VALUES (?, ?, ?, ?, ?)",
    ).run("old", ALICE, AGENT, 1_000, 1_000);
    oldDb.close();

    const upgradedDb = new DatabaseSync(path);
    try {
      const upgradedStore = new ConversationStore(upgradedDb, () => 1_000);
      const columns = upgradedDb.prepare("PRAGMA table_info(conversations)").all();
      expect(columns.filter((column) => column.name === "segment")).toHaveLength(1);

      // The old row counts as segment 1, so a segment 2 resume applies to it.
      const entries = [resume(2), end("user", undefined, 2)];
      expect(upgradedStore.append({ userHash: ALICE, conversationId: "old", entries }))
        .toEqual({ status: "ok" });
      const { conversation } = upgradedStore.get({ userHash: ALICE, conversationId: "old" });
      expect(conversation).toMatchObject({ id: "old", endedBy: "user", state: "ended" });

      // Opening the upgraded file again must not try to add the column twice.
      expect(() => new ConversationStore(upgradedDb)).not.toThrow();
    } finally {
      upgradedDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("still works on an in-memory database, where the journal stays in memory", () => {
    expect(db.prepare("PRAGMA journal_mode").get().journal_mode).toBe("memory");
    expect(open("c1")).toEqual({ status: "opened" });
  });
});

describe("open", () => {
  it("stores a new conversation with started_at = last_entry_at = now", () => {
    expect(open("c1")).toEqual({ status: "opened" });
    const { conversation } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(conversation).toMatchObject({
      id: "c1", agentId: AGENT, startedAt: 1_000, lastEntryAt: 1_000,
      endedAt: null, endedBy: null, endMessage: null, lineCount: 0, turnCount: 0,
    });
  });

  it("is idempotent for the same user and changes nothing", () => {
    open("c1");
    tick();
    expect(open("c1")).toEqual({ status: "exists" });
    const { conversation } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(conversation.startedAt).toBe(1_000);
    expect(count("conversations")).toBe(1);
  });

  it("is forbidden for another user and does not take the conversation over", () => {
    open("c1");
    expect(open("c1", BOB)).toEqual({ status: "forbidden" });
    expect(store.get({ userHash: ALICE, conversationId: "c1" }).status).toBe("ok");
    expect(store.get({ userHash: BOB, conversationId: "c1" })).toEqual({ status: "forbidden" });
  });

  it("is gone after remove and does not re-create the conversation", () => {
    open("c1");
    store.remove({ userHash: ALICE, conversationId: "c1" });
    expect(open("c1")).toEqual({ status: "gone" });
    expect(count("conversations")).toBe(0);
  });
});

describe("append", () => {
  beforeEach(() => open("c1"));

  it("stores lines and turns once when the same batch is sent twice", () => {
    const entries = [line(1), line(2), turn(1)];
    expect(append("c1", entries)).toEqual({ status: "ok" });
    expect(append("c1", entries)).toEqual({ status: "ok" });
    const { conversation } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(conversation).toMatchObject({ lineCount: 2, turnCount: 1 });
  });

  it("keeps the first copy of a retried seq", () => {
    append("c1", [line(1, "original")]);
    append("c1", [line(1, "retry")]);
    const { lines } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(lines.map((l) => l.text)).toEqual(["original"]);
  });

  it("returns lines and turns in seq order whatever order they arrived in", () => {
    append("c1", [line(3), line(1), turn(2), turn(1)]);
    append("c1", [line(2)]);
    const { lines, turns } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(turns.map((t) => t.seq)).toEqual([1, 2]);
  });

  it("bumps last_entry_at and stamps new lines with the receive time", () => {
    tick();
    append("c1", [line(1)]);
    const { conversation } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(conversation.lastEntryAt).toBe(1_010);
    expect(db.prepare("SELECT received_at FROM lines").get().received_at).toBe(1_010);
  });

  it("lets a later segment's ending overwrite an earlier one", () => {
    append("c1", [end("agent", "bye")]);
    tick();
    append("c1", [resume(2)]);
    tick();
    append("c1", [end("error", "late failure", 2)]);
    expect(read("c1")).toMatchObject({
      endedAt: 1_020, endedBy: "error", endMessage: "late failure",
    });
  });

  it("clears the ending when a newer segment resumes", () => {
    append("c1", [end("user")]);
    expect(read("c1")).toMatchObject({ endedBy: "user", state: "ended" });
    tick();
    append("c1", [resume(2)]);
    expect(read("c1")).toMatchObject({
      endedAt: null, endedBy: null, endMessage: null, state: "in-progress",
    });
  });

  it("keeps an end that arrives before the resume of the same segment", () => {
    append("c1", [end("user")]);
    append("c1", [end("agent", "bye", 2)]);
    append("c1", [resume(2)]);
    expect(read("c1")).toMatchObject({ endedBy: "agent", endMessage: "bye" });
  });

  it("ignores a resume of a segment that is not newer than the stored one", () => {
    append("c1", [resume(2), end("user", undefined, 2)]);
    append("c1", [resume(2)]);
    append("c1", [resume(1)]);
    expect(read("c1")).toMatchObject({ endedBy: "user" });
  });

  it("ignores an end of an older segment, which arrived late", () => {
    append("c1", [resume(2), end("agent", "bye", 2)]);
    tick();
    append("c1", [end("error", "stale", 1)]);
    expect(read("c1")).toMatchObject({ endedBy: "agent", endMessage: "bye", endedAt: 1_000 });
  });

  it("applies the entries of one request in array order", () => {
    append("c1", [end("user"), resume(2), end("agent", undefined, 2)]);
    expect(read("c1")).toMatchObject({ endedBy: "agent" });
    append("c1", [resume(3)]);
    expect(read("c1")).toMatchObject({ endedBy: null });
  });

  it("stores an ending without a message as null", () => {
    append("c1", [end("user")]);
    const { conversation } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(conversation).toMatchObject({ endedBy: "user", endMessage: null });
  });

  it("refuses with too-many-lines and writes nothing when a batch would cross the cap", () => {
    const full = Array.from({ length: MAX_LINES_PER_CONVERSATION }, (_, i) => line(i + 1));
    expect(append("c1", full)).toEqual({ status: "ok" });
    tick();

    const crossing = [line(1), line(MAX_LINES_PER_CONVERSATION + 1), turn(1), end("user")];
    expect(append("c1", crossing)).toEqual({ status: "too-many-lines" });

    const { conversation } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(conversation).toMatchObject({
      lineCount: MAX_LINES_PER_CONVERSATION, turnCount: 0, endedAt: null, lastEntryAt: 1_000,
    });
    expect(count("lines")).toBe(MAX_LINES_PER_CONVERSATION);
  });

  it("does not count a batch that only repeats stored seqs toward the cap", () => {
    const full = Array.from({ length: MAX_LINES_PER_CONVERSATION }, (_, i) => line(i + 1));
    append("c1", full);
    expect(append("c1", [line(1), line(2)])).toEqual({ status: "ok" });
    expect(count("lines")).toBe(MAX_LINES_PER_CONVERSATION);
  });

  it("counts a seq repeated inside one batch once", () => {
    const nearlyFull = Array.from({ length: MAX_LINES_PER_CONVERSATION - 1 }, (_, i) => line(i + 1));
    append("c1", nearlyFull);
    const last = MAX_LINES_PER_CONVERSATION;
    expect(append("c1", [line(last), line(last)])).toEqual({ status: "ok" });
  });

  it("is forbidden for another user and writes nothing", () => {
    expect(append("c1", [line(1), end("user")], BOB)).toEqual({ status: "forbidden" });
    const { conversation } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(conversation).toMatchObject({ lineCount: 0, endedAt: null });
  });

  it("is not-found for an unknown conversation", () => {
    expect(append("missing", [line(1)])).toEqual({ status: "not-found" });
    expect(count("lines")).toBe(0);
  });

  it("is gone for a removed conversation", () => {
    store.remove({ userHash: ALICE, conversationId: "c1" });
    expect(append("c1", [line(1)])).toEqual({ status: "gone" });
    expect(count("lines")).toBe(0);
  });

  it("rolls the whole batch back when a later entry throws", () => {
    // A text value in a STRICT REAL column fails the insert; OR IGNORE does not swallow that.
    expect(() => append("c1", [line(1), turn(1, { stt: "slow" })])).toThrow();
    expect(count("lines")).toBe(0);
    // The failed transaction is closed, so the next append can start its own.
    expect(append("c1", [line(1)])).toEqual({ status: "ok" });
  });
});

describe("list", () => {
  it("returns an empty history with zero totals", () => {
    expect(store.list({ userHash: ALICE })).toEqual({
      status: "ok",
      conversations: [],
      nextCursor: null,
      totals: { all: 0, completed: 0, failed: 0 },
    });
  });

  it("lists newest first and breaks started_at ties by id descending", () => {
    open("a");
    open("b"); // same clock tick as "a"
    tick();
    open("c");
    const { conversations } = store.list({ userHash: ALICE });
    expect(conversations.map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("only lists the caller's conversations", () => {
    open("mine");
    open("theirs", BOB);
    const { conversations, totals } = store.list({ userHash: ALICE });
    expect(conversations.map((c) => c.id)).toEqual(["mine"]);
    expect(totals.all).toBe(1);
  });

  it("pages by 50 with nextCursor, and nextCursor is null on the last page", () => {
    for (let i = 0; i < 120; i++) {
      tick();
      open(`c${String(i).padStart(3, "0")}`);
    }
    const first = store.list({ userHash: ALICE });
    expect(first.conversations).toHaveLength(50);
    expect(first.conversations[0].id).toBe("c119");
    expect(first.conversations[49].id).toBe("c070");
    expect(typeof first.nextCursor).toBe("string");

    const second = store.list({ userHash: ALICE, cursor: first.nextCursor });
    expect(second.conversations).toHaveLength(50);
    expect(second.conversations[0].id).toBe("c069");
    expect(second.nextCursor).not.toBeNull();

    const third = store.list({ userHash: ALICE, cursor: second.nextCursor });
    expect(third.conversations).toHaveLength(20);
    expect(third.conversations.at(-1).id).toBe("c000");
    expect(third.nextCursor).toBeNull();
  });

  it("has no next when the history is exactly one page", () => {
    for (let i = 0; i < 50; i++) open(`c${i}`);
    const page = store.list({ userHash: ALICE });
    expect(page.conversations).toHaveLength(50);
    expect(page.nextCursor).toBeNull();
  });

  it("pages across rows that share started_at without skipping or repeating", () => {
    for (const id of ["a", "b", "c", "d", "e"]) open(id);
    const first = store.list({ userHash: ALICE, limit: 2 });
    const second = store.list({ userHash: ALICE, limit: 2, cursor: first.nextCursor });
    const third = store.list({ userHash: ALICE, limit: 2, cursor: second.nextCursor });
    const ids = [...first.conversations, ...second.conversations, ...third.conversations].map((c) => c.id);
    expect(ids).toEqual(["e", "d", "c", "b", "a"]);
    expect(third.nextCursor).toBeNull();
  });

  it("answers bad-cursor to a cursor it did not issue, the empty string included", () => {
    open("a");
    expect(store.list({ userHash: ALICE, cursor: "!!not a cursor!!" })).toEqual({ status: "bad-cursor" });
    expect(store.list({ userHash: ALICE, cursor: "" })).toEqual({ status: "bad-cursor" });
  });

  it("treats an absent cursor as the first page", () => {
    open("a");
    expect(store.list({ userHash: ALICE, cursor: undefined }).conversations).toHaveLength(1);
    expect(store.list({ userHash: ALICE, cursor: null }).conversations).toHaveLength(1);
  });

  it("totals cover the whole history, not the page, and an unfinished conversation counts in all only", () => {
    for (let i = 0; i < 60; i++) {
      tick();
      open(`c${i}`);
      append(`c${i}`, [end(i < 55 ? (i % 2 ? "user" : "agent") : "error", "x")]);
    }
    tick();
    open("unfinished");

    const { conversations, totals } = store.list({ userHash: ALICE });
    expect(conversations).toHaveLength(50);
    expect(totals).toEqual({ all: 61, completed: 55, failed: 5 });
  });

  it("counts a closed ending in all only", () => {
    for (const [id, endedBy] of [["u", "user"], ["a", "agent"], ["e", "error"], ["c", "closed"]]) {
      open(id);
      append(id, [end(endedBy, endedBy === "error" ? "x" : undefined)]);
    }
    expect(store.list({ userHash: ALICE }).totals).toEqual({ all: 4, completed: 2, failed: 1 });
  });

  it("reports line and turn counts per row", () => {
    open("a");
    tick();
    open("b");
    append("a", [line(1), line(2), line(3), turn(1)]);
    append("b", [turn(1), turn(2)]);
    const byId = Object.fromEntries(store.list({ userHash: ALICE }).conversations.map((c) => [c.id, c]));
    expect(byId.a).toMatchObject({ lineCount: 3, turnCount: 1 });
    expect(byId.b).toMatchObject({ lineCount: 0, turnCount: 2 });
  });
});

describe("state", () => {
  beforeEach(() => open("c1"));

  const stateOf = () => store.list({ userHash: ALICE }).conversations[0].state;

  it("is in-progress while the last entry is newer than the window, interrupted from the window on", () => {
    clock += IN_PROGRESS_WINDOW_MS - 1;
    expect(stateOf()).toBe("in-progress");
    expect(read("c1").state).toBe("in-progress");
    clock += 1;
    expect(stateOf()).toBe("interrupted");
    expect(read("c1").state).toBe("interrupted");
  });

  it("restarts the window with every entry", () => {
    clock += IN_PROGRESS_WINDOW_MS;
    append("c1", [line(1)]);
    expect(stateOf()).toBe("in-progress");
  });

  it("is ended whatever the age once there is an ending", () => {
    append("c1", [end("closed")]);
    clock += IN_PROGRESS_WINDOW_MS * 10;
    expect(stateOf()).toBe("ended");
    expect(read("c1").state).toBe("ended");
  });

  it("goes back from ended to in-progress on resume and to interrupted after the window", () => {
    append("c1", [end("user")]);
    tick();
    append("c1", [resume(2)]);
    expect(stateOf()).toBe("in-progress");
    clock += IN_PROGRESS_WINDOW_MS;
    expect(stateOf()).toBe("interrupted");
  });
});

describe("get", () => {
  beforeEach(() => open("c1"));

  it("returns lines and turns with metrics in the shape they went in", () => {
    const metrics = {
      stages: { capture: 5, vad: 10, stt: 120, llm: 300, tts: 200, playback: 50 },
      totalMs: 900, llmTokens: 42, ttsChars: 180,
    };
    append("c1", [line(1, "hello"), { kind: "turn", seq: 1, atMs: 1_000, metrics }]);
    const result = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(result.lines).toEqual([{ seq: 1, speaker: "user", text: "hello", atMs: 100 }]);
    expect(result.turns).toEqual([{ seq: 1, atMs: 1_000, metrics }]);
  });

  it("leaves a stage that was not measured out of stages", () => {
    append("c1", [turn(1, { stt: 120 })]);
    const { turns } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(turns[0].metrics.stages).toEqual({ stt: 120 });
  });

  it("keeps a stage measured as 0 distinct from one that is absent", () => {
    append("c1", [turn(1, { vad: 0 })]);
    const { turns } = store.get({ userHash: ALICE, conversationId: "c1" });
    expect(turns[0].metrics.stages).toEqual({ vad: 0 });
  });

  it("answers forbidden for another user's conversation and not-found for an unknown one", () => {
    expect(store.get({ userHash: BOB, conversationId: "c1" })).toEqual({ status: "forbidden" });
    expect(store.get({ userHash: ALICE, conversationId: "missing" })).toEqual({ status: "not-found" });
  });

  it("answers gone for a removed conversation", () => {
    store.remove({ userHash: ALICE, conversationId: "c1" });
    expect(store.get({ userHash: ALICE, conversationId: "c1" })).toEqual({ status: "gone" });
  });
});

describe("remove", () => {
  beforeEach(() => {
    open("c1");
    open("c2");
    append("c1", [line(1), line(2), turn(1)]);
    append("c2", [line(1), turn(1)]);
  });

  it("cascades to lines and turns without orphans, leaving other conversations alone", () => {
    expect(store.remove({ userHash: ALICE, conversationId: "c1" })).toEqual({ status: "deleted" });
    expect(count("conversations")).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM lines WHERE conversation_id = 'c1'").get().n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM turns WHERE conversation_id = 'c1'").get().n).toBe(0);
    expect(count("lines")).toBe(1);
    expect(count("turns")).toBe(1);
  });

  it("leaves a tombstone with the id, the owner and the deletion time", () => {
    tick();
    store.remove({ userHash: ALICE, conversationId: "c1" });
    expect(db.prepare("SELECT id, user_hash, deleted_at FROM deleted_conversations").all()).toEqual([
      { id: "c1", user_hash: ALICE, deleted_at: 1_010 },
    ]);
  });

  it("answers deleted again to the owner the second time and changes nothing", () => {
    store.remove({ userHash: ALICE, conversationId: "c1" });
    tick();
    expect(store.remove({ userHash: ALICE, conversationId: "c1" })).toEqual({ status: "deleted" });
    expect(db.prepare("SELECT deleted_at FROM deleted_conversations").all()).toEqual([
      { deleted_at: 1_000 },
    ]);
  });

  it("answers not-found to another user's delete of a tombstoned id", () => {
    store.remove({ userHash: ALICE, conversationId: "c1" });
    expect(store.remove({ userHash: BOB, conversationId: "c1" })).toEqual({ status: "not-found" });
    expect(count("deleted_conversations")).toBe(1);
  });

  it("answers forbidden to another user and removes nothing", () => {
    expect(store.remove({ userHash: BOB, conversationId: "c1" })).toEqual({ status: "forbidden" });
    expect(count("conversations")).toBe(2);
    expect(count("lines")).toBe(3);
    expect(count("deleted_conversations")).toBe(0);
  });

  it("answers not-found for an unknown conversation without a tombstone", () => {
    expect(store.remove({ userHash: ALICE, conversationId: "missing" })).toEqual({ status: "not-found" });
    expect(count("deleted_conversations")).toBe(0);
  });
});
