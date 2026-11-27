CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('parent', 'child')),
  UNIQUE (id, role)
) STRICT;

INSERT INTO accounts (id, role) VALUES ('local-parent', 'parent') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS child_profiles (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'child' CHECK (role = 'child'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  age INTEGER CHECK (age BETWEEN 0 AND 120),
  note TEXT NOT NULL,
  FOREIGN KEY (id, role) REFERENCES accounts (id, role) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS parent_children (
  parent_id TEXT NOT NULL,
  parent_role TEXT NOT NULL DEFAULT 'parent' CHECK (parent_role = 'parent'),
  child_id TEXT NOT NULL REFERENCES child_profiles (id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id),
  FOREIGN KEY (parent_id, parent_role) REFERENCES accounts (id, role) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE CHECK (length(label) BETWEEN 1 AND 500)
) STRICT;

CREATE TABLE IF NOT EXISTS rule_versions (
  child_id TEXT NOT NULL REFERENCES child_profiles (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (child_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS rule_version_topics (
  child_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  rule_id INTEGER NOT NULL REFERENCES rules (id),
  PRIMARY KEY (child_id, version, rule_id),
  FOREIGN KEY (child_id, version) REFERENCES rule_versions (child_id, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'failed')),
  provider_session_id TEXT,
  UNIQUE (id, child_id, rules_version),
  FOREIGN KEY (child_id, rules_version) REFERENCES rule_versions (child_id, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE summary_events (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('redirect', 'support')),
  description TEXT NOT NULL,
  rule_id INTEGER,
  turn_id TEXT,
  question TEXT,
  severity INTEGER CHECK (severity BETWEEN 1 AND 3),
  evidence_source TEXT CHECK (evidence_source IN ('input', 'output')),
  evidence_quote TEXT,
  seen_at TEXT,
  CHECK ((reason = 'redirect') = (rule_id IS NOT NULL)),
  FOREIGN KEY (conversation_id, child_id, rules_version)
    REFERENCES conversations (id, child_id, rules_version) ON DELETE CASCADE,
  FOREIGN KEY (child_id, rules_version, rule_id)
    REFERENCES rule_version_topics (child_id, version, rule_id)
) STRICT;

CREATE INDEX IF NOT EXISTS parent_children_child_idx ON parent_children (child_id);
CREATE INDEX IF NOT EXISTS conversations_version_idx ON conversations (child_id, rules_version);
CREATE INDEX summary_events_conversation_idx ON summary_events (conversation_id);
CREATE UNIQUE INDEX summary_events_turn_finding_idx
  ON summary_events (turn_id, conversation_id, reason, COALESCE(rule_id, 0))
  WHERE turn_id IS NOT NULL;
CREATE INDEX summary_events_child_unread_idx
  ON summary_events (child_id, seen_at, turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX summary_events_turn_time_idx
  ON summary_events (occurred_at DESC, turn_id DESC, conversation_id) WHERE turn_id IS NOT NULL;
