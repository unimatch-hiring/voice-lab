// Storage scenarios use isolated temporary directories. Validation runs in memory.
import assert from "node:assert/strict";
import fs, { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHistoryStore, isDialogue, MalformedDialogueError } from "./historyStore.js";

const id = "dialogue";
const startedAt = "2026-11-19T10:00:00.000Z";
const question = { seq: 1, speaker: "user", text: "Can you hear me?", atMs: 100 };
const answer = { seq: 2, speaker: "agent", text: "Yes, I can.", atMs: 500 };

function update(messages, end = null) {
  return { schemaVersion: 1, id, sessions: [{ id: "session", startedAt, end, messages }] };
}

async function historyDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), "voice-lab-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function transcript(store) {
  const dialogue = await store.read(id);
  return dialogue.sessions.flatMap((session) => session.messages.map((message) => message.text));
}

async function expectDiskFull(t, save) {
  const writeFile = fs.writeFile;
  const diskFull = new Error("Disk full");
  // Model a disk that accepts part of the write before reporting a failure.
  const write = t.mock.method(fs, "writeFile", async (path, data, options) => {
    await writeFile(path, data.slice(0, 10), options);
    throw diskFull;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(save, diskFull);
  } finally {
    write.mock.restore();
    syncBuiltinESMExports();
  }
}

test("[TC-009] a failed save leaves the previously acknowledged transcript readable", async (t) => {
  const dir = await historyDirectory(t);
  const store = createHistoryStore(dir);
  await store.save(id, update([question]));

  await expectDiskFull(t, () => store.save(id, update([answer])));

  assert.deepEqual(await transcript(createHistoryStore(dir)), [question.text]);
});

test("[TC-010] a late utterance completes the transcript and preserves the recorded ending", async (t) => {
  const store = createHistoryStore(await historyDirectory(t));
  await store.save(id, update([answer], { reason: "user", durationMs: 60_000 }));
  await store.save(id, update([question]));

  assert.deepEqual(await transcript(store), [question.text, answer.text]);
  const { summaries } = await store.list();
  assert.deepEqual(summaries, [{ id, startedAt, durationMs: 60_000, endReason: "user" }]);
});

test("[TC-011] saving to a damaged dialogue preserves the original file", async (t) => {
  const dir = await historyDirectory(t);
  const path = join(dir, id + ".json");
  const damaged = Buffer.from('{"schemaVersion":1,"sessions":[');
  await fs.writeFile(path, damaged);

  const store = createHistoryStore(dir);
  await assert.rejects(store.save(id, update([answer])), MalformedDialogueError);
  assert.deepEqual(await fs.readFile(path), damaged);
});

test("[TC-012] retrying after a disk failure saves the missing utterance exactly once", async (t) => {
  const dir = await historyDirectory(t);
  const store = createHistoryStore(dir);
  await store.save(id, update([question]));
  const pending = update([answer]);
  await expectDiskFull(t, () => store.save(id, pending));

  await store.save(id, pending);

  assert.deepEqual(await transcript(createHistoryStore(dir)), [question.text, answer.text]);
});

test("[TC-013] history lists the most recently started dialogue first", async (t) => {
  const store = createHistoryStore(await historyDirectory(t));
  const [session] = update([question]).sessions;
  const older = { schemaVersion: 1, id: "a", sessions: [session] };
  const newer = {
    schemaVersion: 1,
    id: "z",
    sessions: [{ ...session, startedAt: "2026-11-20T10:00:00.000Z" }],
  };
  await store.save(older.id, older);
  await store.save(newer.id, newer);

  const { summaries } = await store.list();
  assert.deepEqual(summaries.map((dialogue) => dialogue.id), [newer.id, older.id]);
});

test("[TC-014] the dialogue validator accepts version 1 and rejects version 2", () => {
  const dialogue = update([question]);
  assert.equal(isDialogue(dialogue, id), true);
  assert.equal(isDialogue({ ...dialogue, schemaVersion: 2 }, id), false);
});
