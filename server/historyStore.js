import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const dialogueIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export class MalformedDialogueError extends Error {
  constructor(id) {
    super(`Invalid stored dialogue: ${id}`);
    this.name = "MalformedDialogueError";
  }
}

const isObject = (value) => value !== null && typeof value === "object";
const isId = (value) => typeof value === "string" && dialogueIdPattern.test(value);
const isDuration = (value) => Number.isFinite(value) && value >= 0;

function isMessage(value) {
  return isObject(value)
    && Number.isSafeInteger(value.seq) && value.seq >= 1
    && (value.speaker === "user" || value.speaker === "agent")
    && typeof value.text === "string" && value.text.trim() !== ""
    && isDuration(value.atMs);
}

function isEnding(value) {
  return value === null || (isObject(value)
    && ["user", "agent", "error"].includes(value.reason)
    && isDuration(value.durationMs));
}

function isSession(value) {
  return isObject(value) && isId(value.id)
    && typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt))
    && isEnding(value.end)
    && Array.isArray(value.messages) && value.messages.every(isMessage);
}

export function isDialogue(value, id) {
  return isObject(value) && value.schemaVersion === 1 && value.id === id
    && Array.isArray(value.sessions) && value.sessions.every(isSession);
}

function parseStoredDialogue(raw, id) {
  let dialogue;
  try {
    dialogue = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw new MalformedDialogueError(id);
    throw error;
  }
  if (!isDialogue(dialogue, id)) {
    throw new MalformedDialogueError(id);
  }
  return dialogue;
}

function orMissing(error, fallback) {
  if (error.code !== "ENOENT") throw error;
  return fallback;
}

function mergeDialogue(previous, incoming) {
  const sessions = new Map(previous?.sessions.map((session) => [session.id, session]));
  for (const next of incoming.sessions) {
    const saved = sessions.get(next.id);
    const messages = new Map(saved?.messages.map((message) => [message.seq, message]));
    for (const { seq, speaker, text, atMs } of next.messages) {
      if (!messages.has(seq)) messages.set(seq, { seq, speaker, text, atMs });
    }
    const end = saved?.end ?? next.end;
    sessions.set(next.id, {
      id: next.id,
      startedAt: saved?.startedAt ?? new Date(next.startedAt).toISOString(),
      end: end && { reason: end.reason, durationMs: end.durationMs },
      messages: [...messages.values()].sort((first, second) => first.seq - second.seq),
    });
  }
  return {
    schemaVersion: 1,
    id: incoming.id,
    sessions: [...sessions.values()].sort((first, second) =>
      first.startedAt.localeCompare(second.startedAt),
    ),
  };
}

async function replaceJson(path, dialogue) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(dialogue), { flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function summarize(dialogue) {
  return {
    id: dialogue.id,
    startedAt: dialogue.sessions[0].startedAt,
    durationMs: dialogue.sessions.reduce((total, session) => total + (session.end?.durationMs ?? 0), 0),
    endReason: dialogue.sessions.at(-1).end?.reason ?? null,
  };
}

export function createHistoryStore(dataDir) {
  const changes = new Map();
  const dialoguePath = (id) => join(dataDir, `${id}.json`);
  const deletionPath = (id) => join(dataDir, `${id}.deleted`);

  function change(id, operation) {
    const previous = changes.get(id) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    changes.set(id, queued);
    return queued.finally(() => {
      if (changes.get(id) === queued) changes.delete(id);
    });
  }

  async function isDeleted(id) {
    return access(deletionPath(id)).then(() => true, (error) => orMissing(error, false));
  }

  async function read(id) {
    const saved = await readFile(dialoguePath(id), "utf8").catch((error) => orMissing(error, null));
    return saved === null ? null : parseStoredDialogue(saved, id);
  }

  async function list() {
    const files = await readdir(dataDir).catch((error) => orMissing(error, []));
    const summaries = [];
    let incomplete = false;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      if (!dialogueIdPattern.test(id)) continue;
      try {
        const dialogue = await read(id);
        if (dialogue?.sessions.some((session) => session.messages.length > 0)) {
          summaries.push(summarize(dialogue));
        }
      } catch (error) {
        if (!(error instanceof MalformedDialogueError)) throw error;
        console.warn(error.message);
        incomplete = true;
      }
    }
    summaries.sort((first, second) => second.startedAt.localeCompare(first.startedAt));
    return { summaries, incomplete };
  }

  function save(id, incoming) {
    return change(id, async () => {
      const previous = await read(id);
      if (!previous && await isDeleted(id)) return false;
      const dialogue = mergeDialogue(previous, incoming);
      await mkdir(dataDir, { recursive: true });
      await replaceJson(dialoguePath(id), dialogue);
      return true;
    });
  }

  function remove(id) {
    return change(id, async () => {
      await mkdir(dataDir, { recursive: true });
      // Keep the .deleted marker across restarts so a queued write from another tab cannot recreate the dialogue.
      // If removing the JSON fails, save() still treats the existing transcript as live.
      await writeFile(deletionPath(id), "");
      await rm(dialoguePath(id), { force: true });
    });
  }

  return { read, list, save, remove };
}
