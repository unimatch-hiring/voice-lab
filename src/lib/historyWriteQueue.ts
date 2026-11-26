import { HistoryApiError, saveDialogue, type Dialogue } from "./historyApi";
import {
  persistPendingHistoryWrite,
  readPendingHistoryWrites,
  removePendingHistoryWrite,
  type PendingHistoryWrite,
} from "./historyPendingStorage";

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 8_000;
const REQUEST_TIMEOUT_MS = 10_000;

function canRetry(error: unknown): boolean {
  if (error instanceof HistoryApiError) {
    return error.status === 408 || error.status === 429 ||
      (error.status >= 500 && error.status < 600);
  }
  return error instanceof TypeError;
}

export function createHistoryWriteQueue(onWarning: (warning: string | null) => void) {
  const pending: PendingHistoryWrite[] = [];
  const unpersisted = new Set<string>();
  const deletedDialogues = new Set<string>();
  let running = false;
  let active: AbortController | null = null;
  let retryTimer: number | undefined;
  let retryDelay = INITIAL_RETRY_MS;
  let retrying = false;
  let lostWrite = false;
  let restoreIncomplete = false;
  let order = 0;
  let warning: string | null = null;

  function currentWarning() {
    if (retrying && unpersisted.size) {
      return "History isn’t saving right now. Keep this page open while we keep trying.";
    }
    if (retrying) return "History isn’t saving right now. We’ll keep trying.";
    if (lostWrite) return "Some earlier history could not be saved.";
    if (unpersisted.size) {
      return "History couldn’t keep a local copy. Keep this page open until it is saved.";
    }
    if (restoreIncomplete) return "Some pending history could not be recovered from this browser.";
    return null;
  }

  function report() {
    const next = currentWarning();
    if (next === warning) return;
    warning = next;
    onWarning(next);
  }

  function persist(write: PendingHistoryWrite) {
    try {
      persistPendingHistoryWrite(write);
      unpersisted.delete(write.id);
    } catch (error) {
      if (!unpersisted.has(write.id)) console.warn("History pending write storage failed", error);
      unpersisted.add(write.id);
    }
  }

  function remove(write: PendingHistoryWrite) {
    unpersisted.delete(write.id);
    try {
      removePendingHistoryWrite(write.id);
    } catch (error) {
      console.warn("History pending write cleanup failed", error);
    }
  }

  function reject(write: PendingHistoryWrite, error: unknown) {
    lostWrite = true;
    console.warn("History write rejected", error);
    if (error instanceof HistoryApiError && error.status === 410) {
      const dialogueId = write.dialogue.id;
      deletedDialogues.add(dialogueId);
      for (let index = pending.length - 1; index >= 0; index--) {
        if (pending[index].dialogue.id === dialogueId) {
          remove(pending[index]);
          pending.splice(index, 1);
        }
      }
      return;
    }
    pending.shift();
    remove(write);
  }

  function retry() {
    retrying = true;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      drain();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  }

  async function send(write: PendingHistoryWrite, request: AbortController) {
    const timeout = window.setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
    try {
      await saveDialogue(write.dialogue, request.signal);
      if (active !== request) return;
      pending.shift();
      remove(write);
      retryDelay = INITIAL_RETRY_MS;
    } catch (error) {
      if (active !== request) return;
      if (request.signal.aborted || canRetry(error)) retry();
      else {
        reject(write, error);
        retryDelay = INITIAL_RETRY_MS;
      }
    } finally {
      window.clearTimeout(timeout);
      if (active === request) {
        active = null;
        if (pending.length === 0) retrying = false;
        report();
        drain();
      }
    }
  }

  function drain() {
    if (!running || active || retryTimer !== undefined || pending.length === 0) return;
    const write = pending[0];
    if (unpersisted.has(write.id)) persist(write);
    active = new AbortController();
    void send(write, active);
  }

  function start() {
    running = true;
    try {
      const known = new Set(pending.map(({ id }) => id));
      const { writes, incomplete } = readPendingHistoryWrites();
      for (const write of writes) {
        order = Math.max(order, write.order);
        if (!known.has(write.id)) pending.push(write);
      }
      pending.sort((first, second) => first.order - second.order);
      restoreIncomplete = incomplete;
      if (incomplete) console.warn("Could not read all pending history records");
    } catch (error) {
      restoreIncomplete = true;
      console.warn("History pending write recovery failed", error);
    }
    report();
    drain();
  }

  function stop() {
    running = false;
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    const request = active;
    active = null;
    request?.abort();
  }

  function enqueue(dialogue: Dialogue) {
    if (deletedDialogues.has(dialogue.id)) return;
    order = Math.max(Date.now(), order + 1);
    const write: PendingHistoryWrite = { id: crypto.randomUUID(), order, dialogue };
    pending.push(write);
    persist(write);
    report();
    drain();
  }

  return { start, stop, enqueue };
}
