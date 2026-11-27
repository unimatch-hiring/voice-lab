import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Child, Rule } from "../../shared/parent.ts";
import { openDatabase } from "../src/database.ts";
import { createApp } from "../src/http.ts";

const children = "/api/parent/children";
const rules = "/api/parent/rules";
const schema = new URL("../migrations/001-parent-control.sql", import.meta.url);

type TestApp = ReturnType<typeof createApp>;

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function request(app: TestApp, path: string, { method = "GET", body, headers }: RequestOptions = {}) {
  return app(new Request("http://localhost" + path, {
    method,
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function post<T = unknown>(app: TestApp, path: string, body: unknown, status: number): Promise<T> {
  const response = await request(app, path, { method: "POST", body });
  assert.equal(response.status, status);
  return response.json() as Promise<T>;
}

test("the initial migration creates the complete schema in one pass", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(readFileSync(schema, "utf8"));
  assert.doesNotThrow(() => createApp({ db }));
});

test("db:init creates the configured database and can be run again", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-lab-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "parent", "voice-lab.sqlite");
  const init = () => execSync("npm run db:init", {
    cwd: new URL("../", import.meta.url), env: { ...process.env, DATABASE_PATH: path },
  });
  init();
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    db.prepare("INSERT INTO rules (label) VALUES ('Existing topic')").run();
    init();
    assert.equal(db.prepare("SELECT count(*) AS n FROM accounts WHERE role = 'parent'").get()?.n, 1);
    assert.equal(db.prepare("SELECT label FROM rules").get()?.label, "Existing topic");
  } finally {
    db.close();
  }
});

test("migrates a new file and keeps profiles, reusable topics and old versions after reopening", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-lab-db-"));
  const path = join(dir, "parent", "voice-lab.sqlite");
  let db = openDatabase(path);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let app = createApp({ db });
  assert.deepEqual(await (await request(app, children)).json(), []);
  const topic = await post<Rule>(app, rules, { label: "Подробности развода" }, 201);
  assert.deepEqual(await post(app, rules, { label: "  Подробности развода  " }, 200), topic);
  const another = await post<Rule>(app, rules, { label: "Азартные игры" }, 201);
  const maya = await post<Child>(app, children, {
    displayName: " Maya ", age: 8, note: "Любит космос.", ruleIds: [topic.id],
  }, 201);
  const alex = await post<Child>(app, children, { displayName: "Alex", ruleIds: [topic.id] }, 201);
  assert.match(maya.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(maya.id, alex.id);
  assert.equal(maya.rulesVersion, 1);
  assert.equal(alex.age, null);
  assert.equal(alex.note, "");
  assert.equal(db.prepare("SELECT role FROM accounts WHERE id = ?").get(maya.id)?.role, "child");
  assert.equal(db.prepare("SELECT count(*) AS n FROM parent_children WHERE parent_id = 'local-parent'").get()?.n, 2);

  const updated = await post<Child>(app, children + "/" + maya.id, {
    ...maya, age: 9, ruleIds: [another.id, topic.id, another.id],
  }, 200);
  assert.equal(updated.rulesVersion, 2);
  assert.deepEqual(updated.ruleIds, [topic.id, another.id]);
  const renamed = await post<Child>(app, children + "/" + maya.id, {
    ...updated, displayName: "Maya B", ruleIds: [another.id, topic.id],
  }, 200);
  assert.equal(renamed.rulesVersion, 2);

  db.close();
  db = openDatabase(path);
  app = createApp({ db });
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM accounts WHERE role = 'parent'").get()?.n, 1);
  assert.deepEqual(await (await request(app, children + "/" + maya.id)).json(), renamed);
  assert.deepEqual(await (await request(app, children + "/" + alex.id)).json(), alex);
  assert.deepEqual(await (await request(app, rules)).json(), [topic, another]);
  assert.deepEqual(await (await request(app, children)).json(), [
    { id: alex.id, displayName: "Alex", age: null, unreadAlerts: 0 },
    { id: maya.id, displayName: "Maya B", age: 9, unreadAlerts: 0 },
  ]);
  assert.deepEqual(db.prepare(
    "SELECT rule_id FROM rule_version_topics WHERE child_id = ? AND version = 1",
  ).all(maya.id).map(({ rule_id }) => rule_id), [topic.id]);
});

test("rejects invalid fields and unknown rules without partially changing the profile", async () => {
  const app = createApp();
  const child = await post<Child>(app, children, { displayName: "Maya" }, 201);
  assert.equal(child.rulesVersion, 1);
  assert.deepEqual(child.ruleIds, []);
  for (const fields of [
    { displayName: " " }, { age: -1 }, { age: "9" }, { note: [] }, { ruleIds: [1.5] },
    { displayName: "Changed", ruleIds: [999] },
  ]) {
    await post(app, children + "/" + child.id, { ...child, ...fields }, 400);
  }
  assert.deepEqual(await (await request(app, children + "/" + child.id)).json(), child);
  assert.equal((await request(app, children + "/" + randomUUID())).status, 404);
  assert.equal((await request(app, children + "/" + randomUUID(), { method: "DELETE" })).status, 404);
  await post(app, children + "/" + randomUUID(), { displayName: "Missing" }, 404);
});

test("upgrades a version-one file without losing its profile, conversation or summary", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-lab-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "voice-lab.sqlite");
  const legacy = new DatabaseSync(path);
  const id = randomUUID();
  legacy.exec(readFileSync(schema, "utf8"));
  legacy.exec(`
    DROP INDEX summary_events_turn_finding_idx;
    DROP INDEX summary_events_child_unread_idx;
    DROP INDEX summary_events_turn_time_idx;
    ALTER TABLE summary_events DROP COLUMN turn_id;
    ALTER TABLE summary_events DROP COLUMN question;
    ALTER TABLE summary_events DROP COLUMN severity;
    ALTER TABLE summary_events DROP COLUMN evidence_source;
    ALTER TABLE summary_events DROP COLUMN evidence_quote;
    ALTER TABLE summary_events DROP COLUMN seen_at;
    PRAGMA user_version = 1;
  `);
  legacy.prepare("INSERT INTO accounts (id, role) VALUES (?, 'child')").run(id);
  legacy.prepare("INSERT INTO child_profiles (id, display_name, note) VALUES (?, 'Майя', '')").run(id);
  legacy.prepare("INSERT INTO parent_children (parent_id, child_id) VALUES ('local-parent', ?)").run(id);
  legacy.prepare("INSERT INTO rule_versions (child_id, version) VALUES (?, 1)").run(id);
  legacy.prepare(`
    INSERT INTO conversations (id, child_id, rules_version, started_at, status)
    VALUES ('legacy-call', ?, 1, '2026-11-27T14:00:00Z', 'ended')
  `).run(id);
  legacy.prepare(`
    INSERT INTO summary_events (conversation_id, child_id, rules_version, occurred_at, reason, description)
    VALUES ('legacy-call', ?, 1, '2026-11-27T14:00:00Z', 'support', 'Existing summary')
  `).run(id);
  legacy.close();

  const db = openDatabase(path);
  try {
    const app = createApp({ db });
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.deepEqual(await (await request(app, children)).json(), [
      { id, displayName: "Майя", age: null, unreadAlerts: 0 },
    ]);
    assert.deepEqual(await (await request(app, "/api/parent/alerts")).json(), { items: [], nextCursor: null });
    assert.equal(db.prepare("SELECT status FROM conversations WHERE id = 'legacy-call'").get()?.status, "ended");
    assert.equal(db.prepare("SELECT description FROM summary_events").get()?.description, "Existing summary");
  } finally {
    db.close();
  }
});

test("summary events reference the actual topic version and deleting a child removes its history", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const app = createApp({ db });
  const topic = await post<Rule>(app, rules, { label: "Shared topic" }, 201);
  const unused = await post<Rule>(app, rules, { label: "Unassigned topic" }, 201);
  const child = await post<Child>(app, children, { displayName: "Maya", ruleIds: [topic.id] }, 201);
  const sibling = await post<Child>(app, children, { displayName: "Alex", ruleIds: [topic.id] }, 201);
  const date = "2026-11-27T14:00:00Z";
  const addCall = db.prepare(`
    INSERT INTO conversations (id, child_id, rules_version, started_at, status)
    VALUES ('call', ?, ?, ?, 'active')
  `);
  assert.throws(() => addCall.run(child.id, 2, date), /FOREIGN KEY/);
  addCall.run(child.id, 1, date);
  const addEvent = db.prepare(`
    INSERT INTO summary_events (conversation_id, child_id, rules_version, occurred_at, reason, description, rule_id)
    VALUES ('call', ?, 1, ?, ?, 'Short summary', ?)
  `);
  assert.throws(() => addEvent.run(sibling.id, date, "redirect", topic.id), /FOREIGN KEY/);
  assert.throws(() => addEvent.run(child.id, date, "redirect", unused.id), /FOREIGN KEY/);
  assert.throws(() => addEvent.run(child.id, date, "redirect", null), /CHECK/);
  addEvent.run(child.id, date, "redirect", topic.id);
  addEvent.run(child.id, date, "support", null);
  assert.equal((await request(app, children + "/" + child.id, { method: "DELETE" })).status, 204);
  assert.equal((await request(app, children + "/" + child.id)).status, 404);
  assert.equal((await request(app, "/profile?childId=" + child.id)).status, 404);
  for (const table of ["accounts", "child_profiles", "parent_children", "rule_versions", "rule_version_topics",
    "conversations", "summary_events"]) {
    const column = ["accounts", "child_profiles"].includes(table) ? "id" : "child_id";
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(child.id)?.n, 0, table);
  }
  assert.deepEqual(await (await request(app, children + "/" + sibling.id)).json(), sibling);
  assert.deepEqual(await (await request(app, rules)).json(), [topic, unused]);
});

test("management browser writes require an allowed origin and JSON", async () => {
  const app = createApp();
  const origin = "http://localhost:5173";
  const preflight = await request(app, children, { method: "OPTIONS", headers: { origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /DELETE/);
  assert.equal((await request(app, children, {
    method: "POST", headers: { origin: "https://other.test" }, body: { displayName: "Outsider" },
  })).status, 403);
  assert.equal((await request(app, children, {
    method: "POST", headers: { origin, "content-type": "text/plain" }, body: { displayName: "Wrong type" },
  })).status, 415);
  const saved = await request(app, children, { method: "POST", headers: { origin }, body: { displayName: "Maya" } });
  assert.equal(saved.status, 201);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.equal(saved.headers.get("access-control-allow-origin"), origin);
});
