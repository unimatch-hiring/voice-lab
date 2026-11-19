import { afterEach, expect, test, vi } from "vitest";
import { saveDialogue } from "./historyApi";
import { createHistoryWriteQueue } from "./historyWriteQueue";

vi.mock("./historyApi", async (importOriginal) => ({
  ...await importOriginal(),
  saveDialogue: vi.fn(),
}));

function utterance(seq, text) {
  const message = { seq, text, speaker: "user", atMs: seq * 100 };
  const session = { id: "session", startedAt: "2026-11-19T10:00:00Z", end: null, messages: [message] };
  return { id: "dialogue", schemaVersion: 1, sessions: [session] };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  saveDialogue.mockReset();
  localStorage.clear();
});

test("[TC-006] reopening a damaged queue warns and still delivers the intact utterances in order", async () => {
  const previous = createHistoryWriteQueue(() => {});
  const onWarning = vi.fn();
  const reopened = createHistoryWriteQueue(onWarning);
  const delivered = [];
  saveDialogue.mockImplementation(async (dialogue) => {
    delivered.push(...dialogue.sessions[0].messages.map((message) => message.text));
  });
  try {
    previous.enqueue(utterance(1, "Unreadable after reopening"));
    localStorage.setItem(localStorage.key(0), "{");
    previous.enqueue(utterance(2, "First intact utterance"));
    previous.enqueue(utterance(3, "Next intact utterance"));

    reopened.start();
    expect(onWarning).toHaveBeenCalledWith("Some pending history could not be recovered from this browser.");
    await vi.waitFor(() => expect(delivered).toEqual(["First intact utterance", "Next intact utterance"]));
  } finally {
    reopened.stop();
  }
});

test("[TC-022] reopening sends only the utterance the server has not acknowledged", async () => {
  vi.useFakeTimers();
  const previous = createHistoryWriteQueue(() => {});
  const reopened = createHistoryWriteQueue(() => {});
  const first = utterance(1, "Already saved");
  const second = utterance(2, "Still waiting to be saved");
  saveDialogue.mockResolvedValueOnce().mockRejectedValueOnce(new TypeError("Offline"));

  try {
    previous.enqueue(first);
    previous.enqueue(second);
    previous.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveDialogue.mock.calls.map(([dialogue]) => dialogue)).toEqual([first, second]);
    previous.stop();

    saveDialogue.mockClear().mockResolvedValue(undefined);
    reopened.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveDialogue.mock.calls.map(([dialogue]) => dialogue)).toEqual([second]);
  } finally {
    previous.stop();
    reopened.stop();
  }
});

test("[TC-023] a browser storage failure warns the speaker and the open page delivers from memory", async () => {
  vi.useFakeTimers();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  const onWarning = vi.fn();
  const queue = createHistoryWriteQueue(onWarning);
  const pending = utterance(1, "Keep this until the server comes back");
  const delivered = [];
  saveDialogue.mockRejectedValueOnce(new TypeError("Offline")).mockImplementation(async (dialogue) => {
    delivered.push(dialogue);
  });

  try {
    queue.start();
    queue.enqueue(pending);
    expect(onWarning).toHaveBeenLastCalledWith("History couldn’t keep a local copy. Keep this page open until it is saved.");
    await vi.advanceTimersByTimeAsync(0);
    expect(onWarning).toHaveBeenLastCalledWith("History isn’t saving right now. Keep this page open while we keep trying.");
    expect(delivered).toEqual([]);

    await vi.runAllTimersAsync();
    expect(delivered).toEqual([pending]);
    expect(onWarning).toHaveBeenLastCalledWith(null);
  } finally {
    queue.stop();
  }
});
