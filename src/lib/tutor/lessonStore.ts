/**
 * What the tutor remembers between visits: the level, and what the learner gets wrong.
 *
 * Its own database rather than a key in `tokenStore`'s. That one holds secrets under a
 * non-extractable key and opens with its own schema; a lesson is not a secret, and
 * sharing the store would mean two modules racing to create the same object store for
 * opposite reasons.
 *
 * Nothing here is load-bearing. Private windows and some embedded webviews refuse to
 * open a database at all, so every path degrades to "no memory yet" rather than
 * failing the page: a tutor that forgets is worse than one that never remembered, but
 * a page that will not load is worse than both.
 */

import type { Assessment } from "./level";
import type { Correction } from "./mistakes";

const DB_NAME = "voice-lab-lesson";
const DB_VERSION = 1;
const STORE = "lesson";
const RECORD = "current";

export interface StoredLesson {
  /** Absent until the learner tells us or we have heard enough to guess. */
  level?: Assessment;
  mistakes: Correction[];
  counts: Record<string, number>;
  rechecked: string[];
}

/**
 * A fresh one each time. Handing out one shared object meant a caller that mutated
 * what it was given — and one did — changed what every later failure returned, and
 * then wrote the result back over the stored mistake log.
 */
export const emptyLesson = (): StoredLesson => ({ mistakes: [], counts: {}, rechecked: [] });

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadLesson(): Promise<StoredLesson> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return emptyLesson();
  }
  try {
    const stored = await tx<StoredLesson | undefined>(db, "readonly", (s) => s.get(RECORD));
    if (!stored) return emptyLesson();
    // Field by field with defaults: a record written by an older version is missing
    // whatever was added since, and `state.mistakes.length` on an absent array is the
    // kind of crash that takes the whole page with it.
    return {
      level: stored.level,
      mistakes: stored.mistakes ?? [],
      counts: stored.counts ?? {},
      rechecked: stored.rechecked ?? [],
    };
  } catch {
    return emptyLesson();
  } finally {
    db.close();
  }
}

export async function saveLesson(lesson: StoredLesson): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return;
  }
  try {
    await tx(db, "readwrite", (s) => s.put(lesson, RECORD));
  } catch {
    // Nothing to do and nothing worth interrupting the lesson for.
  } finally {
    db.close();
  }
}
