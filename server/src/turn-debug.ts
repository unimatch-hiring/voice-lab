import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ReviewTurn } from "../../shared/child.ts";
import type { ReviewVerdict } from "./turn-reviews.ts";

export interface TurnDebugEntry extends ReviewTurn {
  childId: string;
  conversationId: string;
  turnId: string;
  occurredAt: string;
  rulesVersion: number;
  status: number;
  modelVerdict: unknown;
  verdict: ReviewVerdict | null;
  error?: string | null;
}

export type TurnDebugLog = (entry: TurnDebugEntry) => void;

export function openTurnDebugLog(
  env: NodeJS.ProcessEnv, host: string, directory = fileURLToPath(new URL("../logs/", import.meta.url)),
): TurnDebugLog | undefined {
  // This log includes verbatim child transcripts. Enable it only for explicit local debugging.
  if (env.TURN_REVIEW_DEBUG !== "1" || env.NODE_ENV === "production" ||
      !["127.0.0.1", "::1", "localhost"].includes(host)) return;

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "turn-reviews.jsonl");
  appendFileSync(path, "", { mode: 0o600 });
  console.log("Turn review debug log:", path);

  return (entry) => {
    try {
      appendFileSync(path, JSON.stringify({ loggedAt: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
    } catch {
      console.warn("Could not write the turn review debug log");
    }
  };
}
