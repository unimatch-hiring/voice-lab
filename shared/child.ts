export const REVIEW_TURN_LIMIT = 10;
export const REVIEW_TEXT_LIMIT = 6000;
export const REQUEST_BODY_LIMIT = 128 * 1024;

export interface ReviewTurn {
  input: string;
  output: string | null;
}

export interface TurnReview {
  childId: string;
  conversationId: string;
  turnId: string;
  occurredAt: string;
  turns: ReviewTurn[];
}

export interface ChildProfile {
  displayName: string;
  prompt: string;
  rulesVersion: number;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export function isChildProfile(value: unknown): value is ChildProfile {
  if (!value || typeof value !== "object") return false;
  const { displayName, prompt, rulesVersion } = value as Partial<ChildProfile>;
  return typeof displayName === "string" && Boolean(displayName.trim()) &&
    typeof prompt === "string" && Boolean(prompt.trim()) &&
    typeof rulesVersion === "number" && Number.isSafeInteger(rulesVersion) && rulesVersion > 0;
}
