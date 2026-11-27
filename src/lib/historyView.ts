import type { StageName, TurnMetrics } from "./types";
import type { StoredConversation, StoredTurn } from "./historyApi";

/**
 * How stored conversations read on the history pages: dates, lengths, outcomes and the
 * median turn. Pure, so the pages only lay these out.
 */

/** The stages that are waiting time. capture and playback are the time someone speaks. */
export const LATENCY_STAGES: readonly StageName[] = ["vad", "stt", "llm", "tts"];

/** `m:ss`, the way a conversation length reads on screen. */
export function formatLength(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  return `${Math.floor(totalSeconds / 60)}:${String(seconds).padStart(2, "0")}`;
}

/** "Wed 25 Nov". `timeZone` is for tests; the page uses the viewer's own. */
export function formatDay(epochMs: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).formatToParts(epochMs);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`;
}

/** "10:14", 24-hour. */
export function formatClock(epochMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(epochMs);
}

export type Outcome =
  | { kind: "completed"; endedBy: "user" | "agent" }
  | { kind: "failed"; message: string }
  // The user left the page: an ending, but neither a success nor a failure.
  | { kind: "closed" }
  | { kind: "in-progress" }
  // The ending never reached the server: the browser crashed, or its last request was lost.
  | { kind: "interrupted" };

export function outcomeOf(conversation: StoredConversation): Outcome {
  switch (conversation.state) {
    case "in-progress":
      return { kind: "in-progress" };
    case "interrupted":
      return { kind: "interrupted" };
    case "ended":
      return endedOutcomeOf(conversation);
  }
}

function endedOutcomeOf(conversation: StoredConversation): Outcome {
  switch (conversation.endedBy) {
    case "user":
    case "agent":
      return { kind: "completed", endedBy: conversation.endedBy };
    case "error":
      return { kind: "failed", message: conversation.endMessage ?? "unknown error" };
    case "closed":
      return { kind: "closed" };
    case null:
      // The server never calls a conversation ended without an ending; show it as lost.
      return { kind: "interrupted" };
  }
}

export function outcomeLabel(outcome: Outcome): string {
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "failed":
      return `failed — ${outcome.message}`;
    case "closed":
      return "ended · you left the page";
    case "in-progress":
      return "in progress";
    case "interrupted":
      return "interrupted · the ending never arrived";
  }
}

/** Who ended it, for the conversation page. */
export function endingLabel(outcome: Outcome): string {
  switch (outcome.kind) {
    case "completed":
      return outcome.endedBy === "user" ? "completed · ended by you" : "completed · ended by the agent";
    case "failed":
      return "failed · ended by an error";
    case "closed":
    case "in-progress":
    case "interrupted":
      return outcomeLabel(outcome);
  }
}

/** The last line of a transcript: how the conversation stopped, led by its length. */
export function transcriptEndLine(outcome: Outcome, lengthMs: number): string {
  const at = `${formatLength(lengthMs)} · `;
  switch (outcome.kind) {
    case "completed":
      return `${at}${outcome.endedBy === "user" ? "you" : "the agent"} ended the conversation`;
    case "failed":
      return `${at}ended by an error: ${outcome.message}`;
    case "closed":
      return `${at}you left the page`;
    case "in-progress":
      return `${at}the conversation is still in progress`;
    case "interrupted":
      return `${at}no ending was recorded`;
  }
}

/**
 * By the server's clock. A conversation without an ending runs to its last entry, the last
 * moment it is known to have been alive.
 */
export function lengthMs(conversation: StoredConversation): number {
  const end = conversation.state === "ended" && conversation.endedAt !== null
    ? conversation.endedAt
    : conversation.lastEntryAt;
  return end - conversation.startedAt;
}

/** "10:14–10:20", or just the start when no ending arrived. */
export function formatTimeRange(conversation: StoredConversation, timeZone?: string): string {
  const start = formatClock(conversation.startedAt, timeZone);
  return conversation.endedAt === null
    ? start
    : `${start}–${formatClock(conversation.endedAt, timeZone)}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface MedianTurn {
  stages: TurnMetrics["stages"];
  totalMs: number;
}

/**
 * The typical turn: each stage's median over the turns that measured it, and the median end
 * to end. Not a real turn — the medians come from different turns. null with no turns.
 */
export function medianTurn(turns: StoredTurn[]): MedianTurn | null {
  if (turns.length === 0) return null;
  const stages: TurnMetrics["stages"] = {};
  for (const stage of LATENCY_STAGES) {
    const measured = turns
      .map((t) => t.metrics.stages[stage])
      .filter((ms): ms is number => ms !== undefined);
    if (measured.length > 0) stages[stage] = median(measured);
  }
  return { stages, totalMs: median(turns.map((t) => t.metrics.totalMs)) };
}

/** Model tokens and synthesised characters over the whole conversation. */
export function conversationTotals(turns: StoredTurn[]): { llmTokens: number; ttsChars: number } {
  return {
    llmTokens: turns.reduce((sum, t) => sum + t.metrics.llmTokens, 0),
    ttsChars: turns.reduce((sum, t) => sum + t.metrics.ttsChars, 0),
  };
}
