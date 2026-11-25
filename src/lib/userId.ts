import { USER_ID_V4 } from "../../shared/historyContract.js";

export const USER_ID_KEY = "voice-lab.historyUser";

/** The two Storage methods this needs, so tests pass a plain object. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The browser's history user id: the stored one, or a new UUID v4 that is stored for next time.
 * null when there is no storage or no generator (crypto.randomUUID exists only in secure contexts).
 */
export function loadUserId(
  storage: KeyValueStorage | null,
  newId: (() => string) | null,
): string | null {
  if (!storage || !newId) return null;

  try {
    const stored = storage.getItem(USER_ID_KEY);
    if (stored !== null && USER_ID_V4.test(stored)) return stored;

    const id = newId();
    storage.setItem(USER_ID_KEY, id);
    return id;
  } catch {
    // No history beats a history nobody can find again under a fresh id.
    return null;
  }
}

export function browserUserId(): string | null {
  return loadUserId(browserStorage(), browserIdGenerator());
}

// Reading `localStorage` itself throws when storage is blocked (private mode, sandboxed frames).
function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserIdGenerator(): (() => string) | null {
  return typeof crypto?.randomUUID === "function" ? () => crypto.randomUUID() : null;
}
