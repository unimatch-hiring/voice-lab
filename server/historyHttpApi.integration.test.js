// These tests exercise the history API over HTTP. Each starts its own server and temporary JSON store.
// Restarts reuse that directory. Only the disk error in the failed-deletion test is simulated.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs, { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHistoryServer } from "./index.js";

const dialogueId = "dialogue";
const dialoguePath = `/dialogues/${dialogueId}`;
const opening = {
  id: "voice-session",
  startedAt: "2026-11-19T10:00:00.000Z",
  end: null,
  messages: [{ seq: 1, speaker: "agent", text: "Welcome.", atMs: 500 }],
};
const reply = {
  ...opening,
  messages: [{ seq: 2, speaker: "user", text: "Tell me a story.", atMs: 1200 }],
};

async function startHistory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "voice-lab-history-"));
  async function listen() {
    const server = createHistoryServer({ dataDir });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
  }

  let server = await listen();
  const close = () => new Promise((resolve) => server.close(resolve));
  t.after(async () => {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function request(path, options) {
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  }

  async function getJson(path) {
    const response = await request(path);
    assert.equal(response.status, 200);
    return response.json();
  }

  return {
    request,
    async restart() {
      await close();
      server = await listen();
    },
    async save(session) {
      const response = await request(dialoguePath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, id: dialogueId, sessions: [session] }),
      });
      return response.status;
    },
    list: () => getJson("/dialogues"),
    async transcript() {
      const dialogue = await getJson(dialoguePath);
      return dialogue.sessions.flatMap((session) => session.messages.map((message) => message.text));
    },
    read: () => request(dialoguePath),
    remove: () => request(dialoguePath, { method: "DELETE" }),
  };
}

test("[TC-001] a final utterance can be read while its session is still open", async (t) => {
  const history = await startHistory(t);
  assert.equal(await history.save(opening), 204);
  assert.deepEqual(await history.transcript(), ["Welcome."]);
});

test("[TC-003] the dialogue transcript and session timings survive a server restart", async (t) => {
  const history = await startHistory(t);
  const silentSession = {
    id: "silent",
    startedAt: "2026-11-19T09:50:00.000Z",
    end: { reason: "user", durationMs: 120_000 },
    messages: [],
  };
  assert.equal(await history.save(silentSession), 204);
  await history.restart();
  assert.deepEqual(await history.list(), []);

  assert.equal(await history.save(opening), 204);
  const acknowledgements = await Promise.all([history.save(reply), history.save(opening)]);
  assert.deepEqual(acknowledgements, [204, 204]);

  await history.restart();
  assert.deepEqual(await history.transcript(), ["Welcome.", "Tell me a story."]);
  assert.deepEqual(await history.list(), [{
    id: dialogueId, startedAt: silentSession.startedAt, durationMs: 120_000, endReason: null,
  }]);
});

test("[TC-005] a failed deletion leaves the dialogue readable and writable until deletion is retried", async (t) => {
  const history = await startHistory(t);
  assert.equal(await history.save(opening), 204);
  const listingBeforeDelete = await history.list();

  const removal = t.mock.method(fs, "rm", async () => { throw new Error("Disk refused deletion"); });
  // The server imports rm by name. Update that binding when installing and restoring the mock.
  syncBuiltinESMExports();
  try {
    assert.equal((await history.remove()).status, 500);
  } finally {
    removal.mock.restore();
    syncBuiltinESMExports();
  }

  assert.deepEqual(await history.list(), listingBeforeDelete);
  assert.deepEqual(await history.transcript(), ["Welcome."]);
  assert.equal(await history.save(reply), 204);
  assert.deepEqual(await history.transcript(), ["Welcome.", "Tell me a story."]);

  assert.equal((await history.remove()).status, 204);
  assert.deepEqual(await history.list(), []);
});

test("[TC-002] a delayed write cannot restore a deleted dialogue after a restart", async (t) => {
  const history = await startHistory(t);
  assert.equal(await history.save(opening), 204);
  assert.equal((await history.remove()).status, 204);

  await history.restart();
  assert.equal(await history.save(reply), 410);
  assert.deepEqual(await history.list(), []);
  assert.equal((await history.read()).status, 404);
});

test("[TC-015] a large transcript update can be saved and read in full", async (t) => {
  const history = await startHistory(t);
  const text = "A long conversation. ".repeat(60_000);
  const session = { ...opening, messages: [{ ...opening.messages[0], text }] };

  assert.equal(await history.save(session), 204);
  assert.deepEqual(await history.transcript(), [text]);
});

test("[TC-016] unsupported methods advertise the route’s methods and unknown paths return 404", async (t) => {
  const history = await startHistory(t);
  const routes = [
    ["/dialogues", ["GET", "OPTIONS"]],
    [dialoguePath, ["DELETE", "GET", "OPTIONS", "PUT"]],
  ];
  for (const [path, methods] of routes) {
    const response = await history.request(path, { method: "POST" });
    assert.equal(response.status, 405, path);
    assert.deepEqual(response.headers.get("allow")?.split(/,\s*/).sort(), methods, path);
  }
  for (const method of ["POST", "OPTIONS"]) {
    const response = await history.request("/unknown", { method });
    assert.equal(response.status, 404, method);
  }
});
