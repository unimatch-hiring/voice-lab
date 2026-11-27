import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { ConversationStore, IN_PROGRESS_WINDOW_MS } from "./store.js";

const LOCAL_ORIGIN = "http://localhost:5173";
const FOREIGN_ORIGIN = "http://evil.example";
const ALICE = "3f2b8c1e-6a4d-4e0b-9c7a-1d5e8f2a4b60";
const BOB = "9b1d4e7a-2c58-4f13-8a6e-0c3b7d9e1f25";
const V1_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const AGENT_ID = "agent-1";

const line = (seq, text = `line ${seq}`) => ({
  kind: "line", seq, speaker: seq % 2 ? "user" : "agent", text, atMs: seq * 100,
});
const turn = (seq, metrics = { stages: { stt: 120, llm: 300 }, totalMs: 900, llmTokens: 42, ttsChars: 180 }) => ({
  kind: "turn", seq, atMs: seq * 1000, metrics,
});
const end = (endedBy, message, segment = 1) => ({
  kind: "end", endedBy, segment, ...(message && { message }),
});
const resume = (segment) => ({ kind: "resume", segment });

let db;
let clock;
let app;
let tempDir;

const tick = (ms = 10) => (clock += ms);
const buildApp = (database) =>
  createApp(new ConversationStore(database, () => clock), { allowedOrigins: [LOCAL_ORIGIN] });

// `user: null` sends no user id; `origin: null` sends no Origin header (like curl).
const send = (method, path, { user = ALICE, origin = LOCAL_ORIGIN, body } = {}) => {
  const headers = {};
  if (user) headers["x-history-user"] = user;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app(new Request(`http://localhost${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
};

const open = (conversationId, options) =>
  send("POST", "/conversations", { ...options, body: { conversationId, agentId: AGENT_ID } });
const append = (conversationId, entries, options) =>
  send("POST", `/conversations/${conversationId}/entries`, { ...options, body: { entries } });
const list = (options, query = "") => send("GET", `/conversations${query}`, options);
const read = (conversationId, options) => send("GET", `/conversations/${conversationId}`, options);
const remove = (conversationId, options) => send("DELETE", `/conversations/${conversationId}`, options);

// A stored conversation that was opened and then given the entries, all of which must be accepted.
const record = async (conversationId, entries = [], options) => {
  expect((await open(conversationId, options)).ok).toBe(true);
  if (entries.length) expect((await append(conversationId, entries, options)).ok).toBe(true);
};
const listBody = async (options, query) => (await list(options, query)).json();
const readBody = async (conversationId, options) => (await read(conversationId, options)).json();

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  clock = 1_000;
  app = buildApp(db);
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("user id", () => {
  it("answers 400 to opening a conversation without a user id and stores nothing", async () => {
    expect((await open("c1", { user: null })).status).toBe(400);
    expect((await listBody()).totals.all).toBe(0);
  });

  it.each([
    ["123", "123"],
    ["a UUID of version 1", V1_UUID],
  ])("answers 400 to the user id %s", async (_name, user) => {
    expect((await open("c1", { user })).status).toBe(400);
    expect((await list({ user })).status).toBe(400);
    expect((await listBody()).totals.all).toBe(0);
  });

  it("answers 400 to listing with the user id not-a-uuid", async () => {
    expect((await list({ user: "not-a-uuid" })).status).toBe(400);
  });
});

describe("opening a conversation", () => {
  it("shows a connected conversation with its agent, start time and no lines", async () => {
    await record("c1");
    const { conversation, lines, turns } = await readBody("c1");
    expect(conversation).toMatchObject({ id: "c1", agentId: AGENT_ID, startedAt: 1_000 });
    expect(lines).toEqual([]);
    expect(turns).toEqual([]);
  });

  it("keeps one record with an unchanged start time when the opening is delivered twice", async () => {
    await record("c1");
    tick(5_000);
    const second = await open("c1");

    expect(second.status).toBe(200);
    const { conversations, totals } = await listBody();
    expect(totals.all).toBe(1);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].startedAt).toBe(1_000);
  });

  it("answers 403 when another user opens an id that is already stored, and changes nothing", async () => {
    await record("c1", [line(1)]);
    tick();

    expect((await open("c1", { user: BOB })).status).toBe(403);

    const { conversation, lines } = await readBody("c1");
    expect(conversation.startedAt).toBe(1_000);
    expect(lines).toHaveLength(1);
    expect((await listBody({ user: BOB })).totals.all).toBe(0);
  });

  it("answers 404 to entries for a conversation that was never opened", async () => {
    expect((await append("missing", [line(1)])).status).toBe(404);
  });
});

describe("storing entries", () => {
  it("stores a line before the conversation ends, in the order it was said", async () => {
    await record("c1", [line(1, "Hello there"), line(2, "Hi, how can I help?")]);

    const { conversation, lines } = await readBody("c1");
    expect(conversation.endedAt).toBeNull();
    expect(lines.map(({ seq, speaker, text, atMs }) => ({ seq, speaker, text, atMs }))).toEqual([
      { seq: 1, speaker: "user", text: "Hello there", atMs: 100 },
      { seq: 2, speaker: "agent", text: "Hi, how can I help?", atMs: 200 },
    ]);
  });

  it("refuses a line with empty text with 400 and stores nothing", async () => {
    await record("c1");

    expect((await append("c1", [line(1, "")])).status).toBe(400);

    expect((await readBody("c1")).lines).toEqual([]);
  });

  it("stores the turn metrics with exactly the delivered values", async () => {
    const metrics = {
      stages: { capture: 5, vad: 10, stt: 120, llm: 300, tts: 200, playback: 50 },
      totalMs: 2400, llmTokens: 12, ttsChars: 80,
    };
    await record("c1", [turn(1, metrics)]);

    const { turns } = await readBody("c1");
    expect(turns).toHaveLength(1);
    expect(turns[0].metrics).toEqual(metrics);
  });

  it("lets the latest ending win: a resume clears the ending, the next end replaces it", async () => {
    await record("c1", [line(1)]);
    tick(100);
    await append("c1", [end("user")]);
    expect((await readBody("c1")).conversation).toMatchObject({ endedBy: "user", state: "ended" });

    tick(100);
    expect((await append("c1", [resume(2)])).ok).toBe(true);
    expect((await readBody("c1")).conversation).toMatchObject({ endedBy: null, endedAt: null });

    tick(100);
    expect((await append("c1", [end("closed", undefined, 2)])).ok).toBe(true);
    expect((await readBody("c1")).conversation).toMatchObject({
      endedBy: "closed", endedAt: clock, state: "ended",
    });
  });

  it("does not let a repeated older delivery undo a newer ending", async () => {
    await record("c1", [line(1), end("user")]);
    await append("c1", [resume(2), end("agent", undefined, 2)]);

    expect((await append("c1", [resume(2)])).ok).toBe(true);
    expect((await append("c1", [end("user")])).ok).toBe(true);

    expect((await readBody("c1")).conversation).toMatchObject({ endedBy: "agent" });
  });

  it("answers 400 to an end with an unknown endedBy or without a segment, and stores nothing", async () => {
    await record("c1");

    expect((await append("c1", [line(1), end("timeout")])).status).toBe(400);
    expect((await append("c1", [line(2), { kind: "end", endedBy: "user" }])).status).toBe(400);
    expect((await append("c1", [{ kind: "resume" }])).status).toBe(400);

    const { conversation, lines } = await readBody("c1");
    expect(lines).toEqual([]);
    expect(conversation.endedBy).toBeNull();
  });

  it("shows state in the list and in the single conversation", async () => {
    await record("c1", [line(1)]);
    await record("c2", [line(1), end("user")]);
    tick(IN_PROGRESS_WINDOW_MS);

    const { conversations } = await listBody();
    const stateById = Object.fromEntries(conversations.map(({ id, state }) => [id, state]));
    expect(stateById).toEqual({ c1: "interrupted", c2: "ended" });
    expect((await readBody("c1")).conversation.state).toBe("interrupted");
  });

  it("keeps the message of an ending by an error", async () => {
    await record("c1", [line(1), end("error", "connection dropped")]);

    const { conversation } = await readBody("c1");
    expect(conversation).toMatchObject({ endedBy: "error", endMessage: "connection dropped" });
  });

  it("stores entries delivered twice once and acknowledges the repeat", async () => {
    const entries = [line(1), line(2), turn(1)];
    await record("c1", entries);
    const repeat = await append("c1", entries);

    expect(repeat.ok).toBe(true);
    const { lines, turns } = await readBody("c1");
    expect(lines).toHaveLength(2);
    expect(turns).toHaveLength(1);
  });

  it("answers 403 to another user appending, and the conversation is unchanged", async () => {
    await record("c1", [line(1)]);

    expect((await append("c1", [line(2), end("user")], { user: BOB })).status).toBe(403);

    const { conversation, lines } = await readBody("c1");
    expect(lines).toHaveLength(1);
    expect(conversation.endedAt).toBeNull();
  });
});

describe("limits", () => {
  it("answers 400 to a line of 4001 characters and stores nothing of the delivery", async () => {
    await record("c1");

    expect((await append("c1", [line(1, "ok"), line(2, "x".repeat(4_001))])).status).toBe(400);

    expect((await readBody("c1")).lines).toEqual([]);
  });

  it("accepts a line of 4000 characters", async () => {
    await record("c1", [line(1, "x".repeat(4_000))]);

    expect((await readBody("c1")).lines).toHaveLength(1);
  });

  it("answers 400 to a delivery of 51 entries and stores none of them", async () => {
    await record("c1");
    const entries = Array.from({ length: 51 }, (_, index) => line(index + 1));

    expect((await append("c1", entries)).status).toBe(400);

    expect((await readBody("c1")).lines).toEqual([]);
  });

  it("accepts a delivery of 50 entries", async () => {
    await record("c1", Array.from({ length: 50 }, (_, index) => line(index + 1)));

    expect((await readBody("c1")).lines).toHaveLength(50);
  });

  it("answers 400 to a line for a conversation that already holds 2000 lines", async () => {
    await record("c1");
    for (let first = 1; first <= 2_000; first += 50) {
      const batch = Array.from({ length: 50 }, (_, index) => line(first + index));
      expect((await append("c1", batch)).ok).toBe(true);
    }

    expect((await append("c1", [line(2_001)])).status).toBe(400);

    expect((await readBody("c1")).lines).toHaveLength(2_000);
  });

  it("Conversation full of lines", async () => {
    await record("c1");
    for (let first = 1; first <= 2_000; first += 50) {
      const batch = Array.from({ length: 50 }, (_, index) => line(first + index));
      expect((await append("c1", batch)).ok).toBe(true);
    }

    expect((await append("c1", [line(2_001)])).status).toBe(400);
    expect((await append("c1", [end("user")])).status).toBe(200);

    const { conversation, lines } = await readBody("c1");
    expect(lines).toHaveLength(2_000);
    expect(conversation.endedBy).toBe("user");
  });

  it("stores nothing from a delivery that crosses the 2000-line cap", async () => {
    await record("c1");
    for (let first = 1; first <= 1_950; first += 50) {
      const batch = Array.from({ length: 50 }, (_, index) => line(first + index));
      expect((await append("c1", batch)).ok).toBe(true);
    }
    await append("c1", Array.from({ length: 49 }, (_, index) => line(1_951 + index)));
    tick();

    const crossing = [line(2_000), line(2_001), turn(1), end("user")];
    expect((await append("c1", crossing)).status).toBe(400);

    const { conversation, lines, turns } = await readBody("c1");
    expect(lines).toHaveLength(1_999);
    expect(turns).toEqual([]);
    expect(conversation.endedAt).toBeNull();
  });
});

describe("origins", () => {
  it("answers 403 to a write from a foreign origin and stores nothing", async () => {
    expect((await open("c1", { origin: FOREIGN_ORIGIN })).status).toBe(403);
    expect((await listBody()).totals.all).toBe(0);
  });

  it("answers 403 to an append from a foreign origin and stores nothing", async () => {
    await record("c1");

    expect((await append("c1", [line(1)], { origin: FOREIGN_ORIGIN })).status).toBe(403);

    expect((await readBody("c1")).lines).toEqual([]);
  });

  it("answers 403 to a list from a foreign origin and returns nothing", async () => {
    await record("c1", [line(1, "private words")]);

    const response = await list({ origin: FOREIGN_ORIGIN });

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("c1");
  });

  it("answers 403 to a read and a delete from a foreign origin", async () => {
    await record("c1");

    expect((await read("c1", { origin: FOREIGN_ORIGIN })).status).toBe(403);
    expect((await remove("c1", { origin: FOREIGN_ORIGIN })).status).toBe(403);

    expect((await read("c1")).status).toBe(200);
  });

  it("accepts the local origin and echoes it in the CORS headers", async () => {
    const response = await open("c1");

    expect(response.ok).toBe(true);
    expect(response.headers.get("access-control-allow-origin")).toBe(LOCAL_ORIGIN);
  });

  it("answers the OPTIONS preflight with 204 and no user id", async () => {
    const response = await send("OPTIONS", "/conversations", { user: null });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(LOCAL_ORIGIN);
  });
});

describe("listing", () => {
  it("lists the owner's conversations with only the user id, no key", async () => {
    await record("c1", [line(1)]);

    const response = await send("GET", "/conversations", { origin: null });

    expect(response.status).toBe(200);
    expect((await response.json()).conversations.map((c) => c.id)).toEqual(["c1"]);
  });

  it("lists only the requesting user's conversations and totals", async () => {
    await record("mine", [line(1), end("user")]);
    await record("theirs", [line(1), end("error", "boom")], { user: BOB });
    await record("theirs-too", [], { user: BOB });

    const alice = await listBody();
    const bob = await listBody({ user: BOB });

    expect(alice.conversations.map((c) => c.id)).toEqual(["mine"]);
    expect(alice.totals).toEqual({ all: 1, completed: 1, failed: 0 });
    expect(bob.conversations.map((c) => c.id).sort()).toEqual(["theirs", "theirs-too"]);
    expect(bob.totals).toEqual({ all: 2, completed: 0, failed: 1 });
  });

  it("lists two conversations newest first with their line and turn counts", async () => {
    await record("ten", [line(1), line(2), line(3), turn(1), end("user")]);
    tick(3_600_000);
    await record("eleven", [turn(1), turn(2), end("agent")]);

    const { conversations } = await listBody();

    expect(conversations.map((c) => c.id)).toEqual(["eleven", "ten"]);
    expect(conversations[0]).toMatchObject({ lineCount: 0, turnCount: 2, endedBy: "agent" });
    expect(conversations[1]).toMatchObject({ lineCount: 3, turnCount: 1, endedBy: "user" });
  });

  it("returns both ends of an unfinished conversation as empty", async () => {
    await record("c1", [line(1)]);

    const { conversations } = await listBody();

    expect(conversations[0]).toMatchObject({ endedAt: null, endedBy: null });
  });

  describe("with 60 conversations", () => {
    // 55 ended normally (alternating visitor and agent), 5 ended by an error.
    beforeEach(async () => {
      for (let index = 1; index <= 60; index += 1) {
        const id = `c${String(index).padStart(3, "0")}`;
        const ending = index <= 5 ? end("error", "boom") : end(index % 2 ? "user" : "agent");
        await record(id, [line(1), ending]);
        tick();
      }
    });

    it("pages 50 then 10, and the last page says there is no next one", async () => {
      const first = await listBody();
      expect(first.conversations).toHaveLength(50);
      expect(first.conversations[0].id).toBe("c060");
      expect(first.conversations[49].id).toBe("c011");
      expect(typeof first.nextCursor).toBe("string");

      const second = await listBody(undefined, `?cursor=${encodeURIComponent(first.nextCursor)}`);
      expect(second.conversations).toHaveLength(10);
      expect(second.conversations[0].id).toBe("c010");
      expect(second.conversations[9].id).toBe("c001");
      expect(second.nextCursor).toBeNull();
    });

    it("carries totals over the whole history on the first page", async () => {
      const { totals } = await listBody();

      expect(totals).toEqual({ all: 60, completed: 55, failed: 5 });
    });

    it("carries the same totals on the second page", async () => {
      const { nextCursor } = await listBody();

      const second = await listBody(undefined, `?cursor=${encodeURIComponent(nextCursor)}`);

      expect(second.totals).toEqual({ all: 60, completed: 55, failed: 5 });
    });

    it("answers 400 to a cursor that does not decode", async () => {
      expect((await list(undefined, "?cursor=%25%25not-a-cursor")).status).toBe(400);
    });
  });

  it("counts a conversation without an ending in the total only", async () => {
    await record("done", [line(1), end("user")]);
    await record("broken", [line(1), end("error", "boom")]);
    await record("unfinished", [line(1)]);

    const { totals } = await listBody();

    expect(totals).toEqual({ all: 3, completed: 1, failed: 1 });
  });
});

describe("reading one conversation", () => {
  it("returns the record with its lines and turns in seq order", async () => {
    await record("c1", [line(1), turn(1), line(2), line(3), turn(2), line(4), end("user")]);

    const { conversation, lines, turns } = await readBody("c1");

    expect(conversation).toMatchObject({ id: "c1", startedAt: 1_000, endedBy: "user" });
    expect(conversation.endedAt).toEqual(expect.any(Number));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(lines.map((l) => l.text)).toEqual(["line 1", "line 2", "line 3", "line 4"]);
    expect(turns.map((t) => t.seq)).toEqual([1, 2]);
  });

  it("returns lines in seq order even when they were delivered out of order", async () => {
    await record("c1", [line(3), line(1), line(2)]);

    expect((await readBody("c1")).lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("shows a lost line as a gap in the sequence numbers", async () => {
    await record("c1", [line(1), line(2), line(4)]);

    expect((await readBody("c1")).lines.map((l) => l.seq)).toEqual([1, 2, 4]);
  });

  it("answers 404 to an unknown id", async () => {
    expect((await read("missing")).status).toBe(404);
  });

  it("answers 404 to another user and returns nothing of the conversation", async () => {
    await record("c1", [line(1, "private words")]);

    const response = await read("c1", { user: BOB });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private words");
  });
});

describe("deleting a conversation", () => {
  it("removes it from the list and the total, and reading it answers 404", async () => {
    await record("a", [line(1)]);
    await record("b", [line(1), turn(1)]);
    await record("c", [line(1)]);

    expect((await remove("b")).status).toBe(204);

    const { conversations, totals } = await listBody();
    expect(conversations.map((c) => c.id).sort()).toEqual(["a", "c"]);
    expect(totals.all).toBe(2);
    expect((await read("b")).status).toBe(404);
  });

  it("answers 404 to another user deleting, and the conversation stays", async () => {
    await record("c1", [line(1)]);

    expect((await remove("c1", { user: BOB })).status).toBe(404);

    expect((await readBody("c1")).lines).toHaveLength(1);
    expect((await listBody()).totals.all).toBe(1);
  });

  it("Delete repeated after a lost answer", async () => {
    await record("c1", [line(1)]);

    expect((await remove("c1")).status).toBe(204);
    expect((await remove("c1")).status).toBe(204);

    const { conversations, totals } = await listBody();
    expect(conversations).toEqual([]);
    expect(totals.all).toBe(0);
    expect((await read("c1")).status).toBe(404);
  });

  it("answers 404 to another user deleting a conversation the owner already deleted", async () => {
    await record("c1");
    await remove("c1");

    expect((await remove("c1", { user: BOB })).status).toBe(404);
  });

  it("answers 404 to deleting an id that was never stored", async () => {
    expect((await remove("missing")).status).toBe(404);
  });

  it("refuses a late line for a deleted conversation with 410 and keeps it absent", async () => {
    await record("c1", [line(1)]);
    await remove("c1");

    expect((await append("c1", [line(2)])).status).toBe(410);

    const { conversations, totals } = await listBody();
    expect(conversations).toEqual([]);
    expect(totals.all).toBe(0);
    expect((await read("c1")).status).toBe(404);
  });

  it("refuses a late opening of a deleted conversation with 410 and keeps it absent", async () => {
    await record("c1");
    await remove("c1");

    expect((await open("c1")).status).toBe(410);

    expect((await listBody()).totals.all).toBe(0);
  });
});

describe("restart", () => {
  it("still lists and reads a conversation after the database file is reopened by a new store", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "voice-lab-history-"));
    const file = join(tempDir, "history.sqlite");
    const firstDb = new DatabaseSync(file);
    app = buildApp(firstDb);
    await record("c1", [line(1, "before the restart"), end("user")]);
    firstDb.close();

    const secondDb = new DatabaseSync(file);
    app = buildApp(secondDb);

    const { conversations, totals } = await listBody();
    expect(conversations.map((c) => c.id)).toEqual(["c1"]);
    expect(totals.all).toBe(1);
    expect((await readBody("c1")).lines[0].text).toBe("before the restart");
    secondDb.close();
  });
});

describe("the user id at rest", () => {
  it("is stored only as its SHA-256, never as sent", async () => {
    await record("conv_hash", [line(1)]);

    const rows = db.prepare("SELECT user_hash FROM conversations").all();
    expect(rows).toEqual([{ user_hash: createHash("sha256").update(ALICE).digest("hex") }]);
    const everyCell = JSON.stringify(db.prepare("SELECT * FROM conversations").all());
    expect(everyCell).not.toContain(ALICE);
  });
});
