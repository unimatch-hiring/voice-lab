/**
 * SQLite storage for conversation history. Every method is synchronous: Node runs one
 * request's SQL to completion, so two appends never interleave. Callers pass arguments
 * that are already validated; this layer only enforces ownership and the line cap.
 * Every public method answers `{ status, ...data }`; nothing returns null or a boolean.
 */

import { MAX_LINES_PER_CONVERSATION, STAGE_NAMES } from "../shared/historyContract.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

/** A conversation with no ending whose last entry is newer than this is still being held. */
export const IN_PROGRESS_WINDOW_MS = 120_000;

const STAGE_COLUMNS = STAGE_NAMES.map((name) => `${name}_ms`).join(", ");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id            TEXT PRIMARY KEY,
    user_hash     TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    last_entry_at INTEGER NOT NULL,
    segment       INTEGER NOT NULL DEFAULT 1,
    ended_at      INTEGER,
    ended_by      TEXT,
    end_message   TEXT
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS conversations_by_user
    ON conversations (user_hash, started_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS lines (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL,
    at_ms INTEGER NOT NULL, received_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS turns (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    capture_ms REAL, vad_ms REAL, stt_ms REAL, llm_ms REAL, tts_ms REAL, playback_ms REAL,
    total_ms REAL NOT NULL, llm_tokens INTEGER NOT NULL, tts_chars INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS deleted_conversations (
    id TEXT PRIMARY KEY, user_hash TEXT NOT NULL, deleted_at INTEGER NOT NULL
  ) STRICT`,
];

/** A database made before segments existed keeps its old table: CREATE TABLE IF NOT EXISTS skips it. */
const ADD_SEGMENT_COLUMN =
  "ALTER TABLE conversations ADD COLUMN segment INTEGER NOT NULL DEFAULT 1";

/** Counts come from correlated subqueries, so a page is one query and not one per row. */
const CONVERSATION_COLUMNS = `
  id, agent_id, started_at, last_entry_at, ended_at, ended_by, end_message,
  (SELECT count(*) FROM lines WHERE lines.conversation_id = conversations.id) AS line_count,
  (SELECT count(*) FROM turns WHERE turns.conversation_id = conversations.id) AS turn_count`;

/** Never stored: it follows from the ending and from how long ago the last entry came. */
const deriveState = (row, now) => {
  if (row.ended_at !== null) return "ended";
  return now - row.last_entry_at < IN_PROGRESS_WINDOW_MS ? "in-progress" : "interrupted";
};

const toConversation = (row, now) => ({
  id: row.id,
  agentId: row.agent_id,
  startedAt: row.started_at,
  lastEntryAt: row.last_entry_at,
  endedAt: row.ended_at,
  endedBy: row.ended_by,
  endMessage: row.end_message,
  lineCount: row.line_count,
  turnCount: row.turn_count,
  state: deriveState(row, now),
});

const toMetrics = (row) => {
  const stages = {};
  for (const name of STAGE_NAMES) {
    const value = row[`${name}_ms`];
    if (value !== null) stages[name] = value;
  }
  return {
    stages,
    totalMs: row.total_ms,
    llmTokens: row.llm_tokens,
    ttsChars: row.tts_chars,
  };
};

export class ConversationStore {
  #db;
  #now;
  #statements;

  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {() => number} now ms clock
   */
  constructor(db, now = () => Date.now()) {
    this.#db = db;
    this.#now = now;
    // WAL lets a reader (docs/history.md invites opening the file in sqlite3) coexist with a
    // writer; the timeout makes a brief lock wait instead of failing the COMMIT. Both are no-ops in :memory:.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 2000");
    for (const statement of SCHEMA) db.exec(statement);
    this.#addSegmentColumnIfMissing();
    this.#statements = this.#prepareStatements();
  }

  #addSegmentColumnIfMissing() {
    const columns = this.#db.prepare("PRAGMA table_info(conversations)").all();
    if (!columns.some((column) => column.name === "segment")) this.#db.exec(ADD_SEGMENT_COLUMN);
  }

  #prepareStatements() {
    const db = this.#db;
    return {
      tombstone: db.prepare("SELECT user_hash FROM deleted_conversations WHERE id = ?"),
      owner: db.prepare("SELECT user_hash FROM conversations WHERE id = ?"),
      insertConversation: db.prepare(
        `INSERT INTO conversations (id, user_hash, agent_id, started_at, last_entry_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      insertLine: db.prepare(
        `INSERT OR IGNORE INTO lines (conversation_id, seq, speaker, text, at_ms, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      countLines: db.prepare("SELECT count(*) AS total FROM lines WHERE conversation_id = ?"),
      insertTurn: db.prepare(
        `INSERT OR IGNORE INTO turns (
           conversation_id, seq, at_ms, ${STAGE_COLUMNS},
           total_ms, llm_tokens, tts_chars
         ) VALUES (?, ?, ?, ${STAGE_NAMES.map(() => "?").join(", ")}, ?, ?, ?)`,
      ),
      // Both rules compare segments, not arrival order, so a retried or late duplicate
      // cannot undo a newer state: a resume needs a newer segment, an end a newer-or-same one.
      resumeConversation: db.prepare(
        `UPDATE conversations
         SET segment = ?, ended_at = NULL, ended_by = NULL, end_message = NULL
         WHERE id = ? AND segment < ?`,
      ),
      endConversation: db.prepare(
        `UPDATE conversations
         SET segment = ?, ended_at = ?, ended_by = ?, end_message = ?
         WHERE id = ? AND segment <= ?`,
      ),
      touchConversation: db.prepare("UPDATE conversations SET last_entry_at = ? WHERE id = ?"),
      listFirstPage: db.prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         WHERE user_hash = ?
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      ),
      listNextPage: db.prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         WHERE user_hash = ? AND (started_at, id) < (?, ?)
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      ),
      totals: db.prepare(
        `SELECT count(*) AS total,
                coalesce(sum(ended_by IN ('user', 'agent')), 0) AS completed,
                coalesce(sum(ended_by = 'error'), 0) AS failed
         FROM conversations WHERE user_hash = ?`,
      ),
      getConversation: db.prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`,
      ),
      getLines: db.prepare(
        "SELECT seq, speaker, text, at_ms FROM lines WHERE conversation_id = ? ORDER BY seq",
      ),
      getTurns: db.prepare(
        `SELECT seq, at_ms, ${STAGE_COLUMNS}, total_ms, llm_tokens, tts_chars
         FROM turns WHERE conversation_id = ? ORDER BY seq`,
      ),
      deleteConversation: db.prepare("DELETE FROM conversations WHERE id = ?"),
      insertTombstone: db.prepare(
        "INSERT INTO deleted_conversations (id, user_hash, deleted_at) VALUES (?, ?, ?)",
      ),
    };
  }

  /**
   * Runs `work` in one transaction. The result is committed when `isSuccess` accepts it
   * and rolled back otherwise, so a refusal leaves no partial write behind.
   */
  #transaction(work, isSuccess) {
    this.#db.exec("BEGIN");
    try {
      const result = work();
      this.#db.exec(isSuccess(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * The one place that decides whether a user may touch a conversation:
   * "gone" (deleted), "not-found", "forbidden" (someone else's) or "ok".
   */
  #checkAccess(userHash, conversationId) {
    const statements = this.#statements;
    if (statements.tombstone.get(conversationId)) return "gone";
    const stored = statements.owner.get(conversationId);
    if (!stored) return "not-found";
    return stored.user_hash === userHash ? "ok" : "forbidden";
  }

  open({ userHash, conversationId, agentId }) {
    const access = this.#checkAccess(userHash, conversationId);
    if (access === "ok") return { status: "exists" };
    if (access !== "not-found") return { status: access };
    const startedAt = this.#now();
    this.#statements.insertConversation.run(
      conversationId, userHash, agentId, startedAt, startedAt,
    );
    return { status: "opened" };
  }

  append({ userHash, conversationId, entries }) {
    return this.#transaction(
      () => this.#appendEntries(userHash, conversationId, entries),
      (result) => result.status === "ok",
    );
  }

  #appendEntries(userHash, conversationId, entries) {
    const access = this.#checkAccess(userHash, conversationId);
    if (access !== "ok") return { status: access };

    const statements = this.#statements;
    const now = this.#now();
    for (const entry of entries) {
      if (entry.kind === "line") {
        statements.insertLine.run(
          conversationId, entry.seq, entry.speaker, entry.text, entry.atMs, now,
        );
      }
    }
    // Counting after the inserts covers retried seqs and duplicates inside one batch;
    // the rollback then discards the whole batch.
    if (statements.countLines.get(conversationId).total > MAX_LINES_PER_CONVERSATION) {
      return { status: "too-many-lines" };
    }

    for (const entry of entries) {
      if (entry.kind === "turn") this.#insertTurn(conversationId, entry);
      if (entry.kind === "resume") {
        statements.resumeConversation.run(entry.segment, conversationId, entry.segment);
      }
      if (entry.kind === "end") {
        statements.endConversation.run(
          entry.segment, now, entry.endedBy, entry.message ?? null, conversationId, entry.segment,
        );
      }
    }
    statements.touchConversation.run(now, conversationId);
    return { status: "ok" };
  }

  #insertTurn(conversationId, { seq, atMs, metrics }) {
    this.#statements.insertTurn.run(
      conversationId, seq, atMs,
      ...STAGE_NAMES.map((name) => metrics.stages[name] ?? null),
      metrics.totalMs, metrics.llmTokens, metrics.ttsChars,
    );
  }

  /** @param {string | null} [cursor] the `nextCursor` of the previous page; none for the first */
  list({ userHash, cursor = null, limit = 50 }) {
    const statements = this.#statements;
    const after = cursor === null ? null : decodeCursor(cursor);
    if (cursor !== null && !after) return { status: "bad-cursor" };
    // One extra row tells whether another page exists.
    const rows = after
      ? statements.listNextPage.all(userHash, after.startedAt, after.id, limit + 1)
      : statements.listFirstPage.all(userHash, limit + 1);
    const now = this.#now();
    const page = rows.slice(0, limit).map((row) => toConversation(row, now));
    const last = page.at(-1);
    const nextCursor = rows.length > limit ? encodeCursor(last) : null;

    const totals = statements.totals.get(userHash);
    return {
      status: "ok",
      conversations: page,
      nextCursor,
      totals: { all: totals.total, completed: totals.completed, failed: totals.failed },
    };
  }

  get({ userHash, conversationId }) {
    const access = this.#checkAccess(userHash, conversationId);
    if (access !== "ok") return { status: access };
    const statements = this.#statements;
    return {
      status: "ok",
      conversation: toConversation(statements.getConversation.get(conversationId), this.#now()),
      lines: statements.getLines.all(conversationId).map((line) => ({
        seq: line.seq,
        speaker: line.speaker,
        text: line.text,
        atMs: line.at_ms,
      })),
      turns: statements.getTurns.all(conversationId).map((turn) => ({
        seq: turn.seq,
        atMs: turn.at_ms,
        metrics: toMetrics(turn),
      })),
    };
  }

  remove({ userHash, conversationId }) {
    return this.#transaction(
      () => this.#removeConversation(userHash, conversationId),
      (result) => result.status === "deleted",
    );
  }

  #removeConversation(userHash, conversationId) {
    const statements = this.#statements;
    const access = this.#checkAccess(userHash, conversationId);
    if (access === "gone") {
      // A repeated delete by the owner succeeds, so a lost answer can be retried.
      const { user_hash: deletedBy } = statements.tombstone.get(conversationId);
      return { status: deletedBy === userHash ? "deleted" : "not-found" };
    }
    if (access !== "ok") return { status: access };
    statements.deleteConversation.run(conversationId);
    statements.insertTombstone.run(conversationId, userHash, this.#now());
    return { status: "deleted" };
  }
}
