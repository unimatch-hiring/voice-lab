import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LOCAL_PARENT, type Child, type ChildFields, type ChildSummary, type Rule } from "../../shared/parent.ts";
import { transaction } from "./database.ts";

export interface SavedProfile {
  child: Omit<Child, "ruleIds">;
  topics: Rule[];
}

type ProfileRow = SavedProfile["child"] & { topics: string };

export type ParentStore = ReturnType<typeof createParentStore>;

export function createParentStore(db: DatabaseSync) {
  const listChildren = db.prepare(`
    SELECT child.id, child.display_name AS displayName, child.age,
      (SELECT count(DISTINCT event.turn_id) FROM summary_events event
       WHERE event.child_id = child.id AND event.seen_at IS NULL) AS unreadAlerts
    FROM child_profiles child JOIN parent_children link ON link.child_id = child.id
    WHERE link.parent_id = ? ORDER BY child.display_name COLLATE NOCASE, child.id
  `);
  const readChild = db.prepare(`
    SELECT child.id, child.display_name AS displayName, child.age, child.note,
      version.version AS rulesVersion,
      (SELECT json_group_array(json_object('id', rule.id, 'label', rule.label) ORDER BY rule.id)
       FROM rule_version_topics topic JOIN rules rule ON rule.id = topic.rule_id
       WHERE topic.child_id = child.id AND topic.version = version.version) AS topics
    FROM child_profiles child
    JOIN parent_children link ON link.child_id = child.id
    JOIN rule_versions version ON version.child_id = child.id
    WHERE link.parent_id = ? AND child.id = ? AND (? IS NULL OR version.version = ?)
    ORDER BY version.version DESC LIMIT 1
  `);
  const listRules = db.prepare("SELECT id, label FROM rules ORDER BY id");
  const addRule = db.prepare("INSERT INTO rules (label) VALUES (?) ON CONFLICT DO NOTHING RETURNING id, label");
  const readRule = db.prepare("SELECT id, label FROM rules WHERE label = ?");
  const hasRule = db.prepare("SELECT 1 FROM rules WHERE id = ?");
  const addAccount = db.prepare("INSERT INTO accounts (id, role) VALUES (?, 'child')");
  const addChild = db.prepare("INSERT INTO child_profiles (id, display_name, age, note) VALUES (?, ?, ?, ?)");
  const addLink = db.prepare("INSERT INTO parent_children (parent_id, child_id) VALUES (?, ?)");
  const updateChild = db.prepare("UPDATE child_profiles SET display_name = ?, age = ?, note = ? WHERE id = ?");
  const removeChild = db.prepare(`
    DELETE FROM accounts WHERE id = ? AND role = 'child'
    AND EXISTS (SELECT 1 FROM parent_children WHERE child_id = accounts.id AND parent_id = ?)
  `);
  const addVersion = db.prepare("INSERT INTO rule_versions (child_id, version) VALUES (?, ?)");
  const assignRule = db.prepare("INSERT INTO rule_version_topics (child_id, version, rule_id) VALUES (?, ?, ?)");

  function profile(id: string, version: number | null = null): SavedProfile | undefined {
    const row = readChild.get(LOCAL_PARENT, id, version, version) as ProfileRow | undefined;
    if (!row) return;
    const { topics, ...child } = row;
    return { child, topics: JSON.parse(topics) as Rule[] };
  }

  function child(id: string): Child | undefined {
    const current = profile(id);
    if (current) return { ...current.child, ruleIds: current.topics.map(({ id }) => id) };
  }

  function saveChild(childId: string | undefined, { displayName, age, note, ruleIds }: ChildFields) {
    return transaction(db, () => {
      const current = childId ? child(childId) : undefined;
      if (childId && !current) return { error: "missing" as const };
      if (ruleIds.some((ruleId) => !hasRule.get(ruleId))) return { error: "invalid_rule" as const };
      const id = childId ?? randomUUID();
      if (current) {
        updateChild.run(displayName, age, note, id);
      } else {
        addAccount.run(id);
        addChild.run(id, displayName, age, note);
        addLink.run(LOCAL_PARENT, id);
      }
      if (!current || ruleIds.length !== current.ruleIds.length ||
          ruleIds.some((ruleId, index) => ruleId !== current.ruleIds[index])) {
        const version = (current?.rulesVersion ?? 0) + 1;
        addVersion.run(id, version);
        for (const ruleId of ruleIds) assignRule.run(id, version, ruleId);
      }
      return { child: child(id) };
    });
  }

  return {
    listChildren: () => listChildren.all(LOCAL_PARENT) as ChildSummary[],
    child,
    profile,
    saveChild,
    deleteChild: (id: string) => removeChild.run(id, LOCAL_PARENT).changes > 0,
    listRules: () => listRules.all() as Rule[],
    saveRule(label: string) {
      const created = addRule.get(label) as Rule | undefined;
      const rule = created ?? (readRule.get(label) as Rule | undefined);
      return { created: Boolean(created), rule };
    },
  };
}
