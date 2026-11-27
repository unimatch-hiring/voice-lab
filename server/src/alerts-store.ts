import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ReviewTurn, TurnReview } from "../../shared/child.ts";
import { LOCAL_PARENT, type AlertFinding, type AlertPage, type ReviewAlert } from "../../shared/parent.ts";
import { transaction } from "./database.ts";

const PAGE_SIZE = 25;

export interface AlertCursor {
  occurredAt: string;
  turnId: string;
}

export interface ReviewInput extends Omit<TurnReview, "turns"> {
  turns: [ReviewTurn, ...ReviewTurn[]];
}

type FindingRow = {
  reason: "redirect" | "support";
  severity: AlertFinding["severity"];
  description: string;
  evidence_source: AlertFinding["evidence"]["source"];
  evidence_quote: string;
} & ({ rule_id: null; rule_label: null } | { rule_id: number; rule_label: string });

type AlertRow = FindingRow & {
  turn_id: string;
  child_id: string;
  child_name: string;
  occurred_at: string;
  question: string;
  seen_at: string | null;
};

export type AlertsStore = ReturnType<typeof createAlertsStore>;

function finding(event: FindingRow): AlertFinding {
  return {
    kind: event.reason === "redirect" ? "forbidden_topic" : "concern",
    severity: event.severity,
    description: event.description,
    evidence: { source: event.evidence_source, quote: event.evidence_quote },
    ...(event.rule_id === null ? {} : { rule: { id: event.rule_id, label: event.rule_label } }),
  };
}

export function createAlertsStore(db: DatabaseSync) {
  const open = db.prepare(`
    INSERT INTO conversations (id, child_id, rules_version, started_at, status)
    VALUES (?, ?, ?, ?, 'active')
  `);
  const find = db.prepare("SELECT rules_version AS rulesVersion FROM conversations WHERE id = ? AND child_id = ?");
  const end = db.prepare(`
    UPDATE conversations SET status = ?, ended_at = ?
    WHERE id = ? AND child_id = ? AND status = 'active'
  `);
  const recorded = db.prepare(`
    SELECT event.*, rule.label AS rule_label FROM summary_events event
    LEFT JOIN rules rule ON rule.id = event.rule_id
    WHERE event.conversation_id = ? AND event.turn_id = ? ORDER BY event.id
  `);
  const insert = db.prepare(`
    INSERT INTO summary_events
      (conversation_id, child_id, rules_version, occurred_at, reason, description, rule_id,
       turn_id, question, severity, evidence_source, evidence_quote)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const turnOwner = db.prepare("SELECT conversation_id FROM summary_events WHERE turn_id = ? LIMIT 1");
  const page = db.prepare(`
    WITH selected AS (
      SELECT event.turn_id, event.conversation_id, event.occurred_at
      FROM summary_events event JOIN parent_children link ON link.child_id = event.child_id
      WHERE link.parent_id = ? AND event.turn_id IS NOT NULL AND (? IS NULL OR event.child_id = ?)
        AND (? IS NULL OR (event.occurred_at, event.turn_id) < (?, ?))
      GROUP BY event.turn_id, event.conversation_id, event.occurred_at
      ORDER BY event.occurred_at DESC, event.turn_id DESC LIMIT ?
    )
    SELECT event.*, child.display_name AS child_name, rule.label AS rule_label
    FROM selected JOIN summary_events event
      ON event.conversation_id = selected.conversation_id AND event.turn_id = selected.turn_id
    JOIN child_profiles child ON child.id = event.child_id
    LEFT JOIN rules rule ON rule.id = event.rule_id
    ORDER BY selected.occurred_at DESC, selected.turn_id DESC, event.id
  `);
  const setSeen = db.prepare(`
    UPDATE summary_events SET seen_at = ? WHERE turn_id = ? AND seen_at IS NULL
    AND EXISTS (SELECT 1 FROM parent_children WHERE child_id = summary_events.child_id AND parent_id = ?)
  `);

  function findings(conversationId: string, turnId: string): AlertFinding[] {
    return (recorded.all(conversationId, turnId) as FindingRow[]).map(finding);
  }

  return {
    startConversation(childId: string, version: number) {
      const id = randomUUID();
      open.run(id, childId, version, new Date().toISOString());
      return id;
    },
    conversation: (id: string, childId: string) => find.get(id, childId) as { rulesVersion: number } | undefined,
    endConversation(id: string, childId: string, status: "ended" | "failed") {
      end.run(status, new Date().toISOString(), id, childId);
    },
    findings,
    save(review: ReviewInput, rulesVersion: number, items: AlertFinding[]) {
      return transaction(db, () => {
        if (!find.get(review.conversationId, review.childId)) return null;
        const existing = turnOwner.get(review.turnId);
        if (existing) return existing.conversation_id === review.conversationId
          ? findings(review.conversationId, review.turnId)
          : null;
        // Earlier turns are context. The stored question comes from the current turn.
        const { input: question } = review.turns.at(-1)!;
        for (const item of items) {
          insert.run(review.conversationId, review.childId, rulesVersion, review.occurredAt,
            item.kind === "forbidden_topic" ? "redirect" : "support", item.description, item.rule?.id ?? null,
            review.turnId, question, item.severity, item.evidence.source, item.evidence.quote);
        }
        return items;
      });
    },
    list(childId: string | null = null, cursor: AlertCursor | null = null): AlertPage {
      const date = cursor?.occurredAt ?? null;
      const rows = page.all(
        LOCAL_PARENT, childId, childId, date, date, cursor?.turnId ?? null, PAGE_SIZE + 1,
      ) as AlertRow[];
      const alerts = new Map<string, ReviewAlert>();
      for (const row of rows) {
        let alert = alerts.get(row.turn_id);
        if (!alert) {
          alert = {
            turnId: row.turn_id,
            childId: row.child_id,
            childName: row.child_name,
            occurredAt: row.occurred_at,
            question: row.question,
            seenAt: row.seen_at,
            severity: row.severity,
            findings: [],
          };
          alerts.set(row.turn_id, alert);
        }
        if (row.seen_at === null) alert.seenAt = null;
        if (row.severity > alert.severity) alert.severity = row.severity;
        alert.findings.push(finding(row));
      }
      const items = [...alerts.values()].slice(0, PAGE_SIZE);
      const last = items.at(-1);
      const nextCursor = last && alerts.size > PAGE_SIZE
        ? Buffer.from(JSON.stringify({ occurredAt: last.occurredAt, turnId: last.turnId })).toString("base64url")
        : null;
      return { items, nextCursor };
    },
    markSeen(ids: readonly string[]) {
      const at = new Date().toISOString();
      transaction(db, () => {
        for (const id of ids) setSeen.run(at, id, LOCAL_PARENT);
      });
    },
  };
}
