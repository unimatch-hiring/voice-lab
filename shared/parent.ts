export const LOCAL_PARENT = "local-parent";

export interface ChildFields {
  displayName: string;
  age: number | null;
  note: string;
  ruleIds: number[];
}

export interface Child extends ChildFields {
  id: string;
  rulesVersion: number;
}

export type ChildSummary = Pick<Child, "id" | "displayName" | "age"> & { unreadAlerts: number };

export type Rule = {
  id: number;
  label: string;
};

export interface AlertFinding {
  kind: "forbidden_topic" | "concern";
  severity: 1 | 2 | 3;
  description: string;
  evidence: { source: "input" | "output"; quote: string };
  rule?: Rule;
}

export interface ReviewAlert {
  turnId: string;
  childId: string;
  childName: string;
  occurredAt: string;
  question: string;
  seenAt: string | null;
  severity: AlertFinding["severity"];
  findings: AlertFinding[];
}

export interface AlertPage {
  items: ReviewAlert[];
  nextCursor: string | null;
}
