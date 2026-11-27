import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const DEFAULT_DATABASE_PATH = fileURLToPath(new URL("../.data/voice-lab.sqlite", import.meta.url));
const schema = new URL("../migrations/001-parent-control.sql", import.meta.url);
const SCHEMA_VERSION = 2;

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(path = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  try {
    transaction(db, () => {
      const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version > SCHEMA_VERSION) throw new Error("The database schema is newer than this server");
      if (version === SCHEMA_VERSION) return;

      // Version one predates turn alerts. Rebuild that table from the same schema as new files.
      if (version === 1) {
        db.exec(`
          ALTER TABLE summary_events RENAME TO summary_events_v1;
          DROP INDEX summary_events_conversation_idx;
        `);
      }
      db.exec(readFileSync(schema, "utf8"));
      if (version === 1) {
        db.exec(`
          INSERT INTO summary_events (id, conversation_id, child_id, rules_version, occurred_at, reason, description, rule_id)
          SELECT id, conversation_id, child_id, rules_version, occurred_at, reason, description, rule_id FROM summary_events_v1;
          DROP TABLE summary_events_v1;
        `);
      }
      db.exec("PRAGMA user_version = " + SCHEMA_VERSION);
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
