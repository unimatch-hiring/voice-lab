import { expect, test, vi } from "vitest";
import {
  persistPendingHistoryWrite,
  readPendingHistoryWrites,
  type PendingHistoryWrite,
} from "./historyPendingStorage";

test("[TC-025] a pending utterance can only be recovered for its original history server", () => {
  const pending: PendingHistoryWrite = {
    id: "write", order: 1,
    dialogue: {
      schemaVersion: 1, id: "dialogue",
      sessions: [{
        id: "session", startedAt: "2026-11-19T10:00:00Z", end: null,
        messages: [{ seq: 1, speaker: "user", text: "Save this for the original server", atMs: 100 }],
      }],
    },
  };
  try {
    vi.stubEnv("VITE_HISTORY_URL", "https://first.example");
    persistPendingHistoryWrite(pending);
    vi.stubEnv("VITE_HISTORY_URL", "https://second.example");
    expect(readPendingHistoryWrites()).toEqual({ writes: [], incomplete: false });

    vi.stubEnv("VITE_HISTORY_URL", "https://first.example");
    expect(readPendingHistoryWrites()).toEqual({ writes: [pending], incomplete: false });
  } finally {
    vi.unstubAllEnvs();
    localStorage.clear();
  }
});
