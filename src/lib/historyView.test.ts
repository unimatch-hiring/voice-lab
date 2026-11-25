import { describe, expect, it } from "vitest";
import type { StoredConversation, StoredTurn } from "./historyApi";
import {
  conversationTotals, endingLabel, formatDay, formatTimeRange, lengthMs, medianTurn, outcomeLabel,
  outcomeOf, transcriptEndLine,
} from "./historyView";

const START = Date.UTC(2026, 10, 25, 10, 14, 0);

function conversation(overrides: Partial<StoredConversation> = {}): StoredConversation {
  return {
    id: "c1",
    agentId: "a1",
    startedAt: START,
    lastEntryAt: START + 408_000,
    endedAt: START + 408_000,
    endedBy: "user",
    state: "ended",
    endMessage: null,
    lineCount: 0,
    turnCount: 0,
    ...overrides,
  };
}

function turn(stages: StoredTurn["metrics"]["stages"], totalMs: number, seq = 1): StoredTurn {
  return { seq, atMs: seq * 10_000, metrics: { stages, totalMs, llmTokens: 10, ttsChars: 40 } };
}

describe("dates and lengths", () => {
  it("reads a start as weekday, day and month, and a range as start–end", () => {
    expect(formatDay(START, "UTC")).toBe("Wed 25 Nov");
    expect(formatTimeRange(conversation(), "UTC")).toBe("10:14–10:20");
  });

  it("measures an ended conversation from the server's start to its end", () => {
    expect(lengthMs(conversation({ lastEntryAt: START + 400_000 }))).toBe(408_000);
  });

  it("measures a conversation without an ending to its last entry", () => {
    const inProgress = conversation({ endedAt: null, endedBy: null, state: "in-progress", lastEntryAt: START + 95_000 });
    const interrupted = conversation({ endedAt: null, endedBy: null, state: "interrupted", lastEntryAt: START + 95_000 });
    expect(lengthMs(inProgress)).toBe(95_000);
    expect(lengthMs(interrupted)).toBe(95_000);
  });

  it("has no end time when the ending never arrived", () => {
    const open = conversation({ endedAt: null, endedBy: null, state: "interrupted" });
    expect(formatTimeRange(open, "UTC")).toBe("10:14");
  });
});

describe("outcome", () => {
  const withoutEnding = { endedAt: null, endedBy: null, endMessage: null } as const;

  it("is completed when the visitor or the agent ended it", () => {
    expect(outcomeOf(conversation({ endedBy: "user" }))).toEqual({ kind: "completed", endedBy: "user" });
    expect(outcomeOf(conversation({ endedBy: "agent" }))).toEqual({ kind: "completed", endedBy: "agent" });
    expect(outcomeLabel(outcomeOf(conversation({ endedBy: "user" })))).toBe("completed");
    expect(endingLabel(outcomeOf(conversation({ endedBy: "user" })))).toBe("completed · ended by you");
    expect(endingLabel(outcomeOf(conversation({ endedBy: "agent" })))).toBe("completed · ended by the agent");
  });

  it("is failed with the stored message when an error ended it", () => {
    const failed = conversation({ endedBy: "error", endMessage: "socket closed" });
    expect(outcomeOf(failed).kind).toBe("failed");
    expect(outcomeLabel(outcomeOf(failed))).toBe("failed — socket closed");
    expect(endingLabel(outcomeOf(failed))).toBe("failed · ended by an error");
  });

  it("is closed, neither completed nor failed, when the visitor left the page", () => {
    const closed = outcomeOf(conversation({ endedBy: "closed" }));
    expect(closed.kind).toBe("closed");
    expect(outcomeLabel(closed)).toBe("ended · you left the page");
    expect(endingLabel(closed)).toBe("ended · you left the page");
  });

  it("is in progress while the server still sees recent entries", () => {
    const inProgress = outcomeOf(conversation({ ...withoutEnding, state: "in-progress" }));
    expect(inProgress.kind).toBe("in-progress");
    expect(outcomeLabel(inProgress)).toBe("in progress");
    expect(endingLabel(inProgress)).toBe("in progress");
  });

  it("is interrupted when no ending arrived and the entries stopped", () => {
    const interrupted = outcomeOf(conversation({ ...withoutEnding, state: "interrupted" }));
    expect(interrupted.kind).toBe("interrupted");
    expect(outcomeLabel(interrupted)).toBe("interrupted · the ending never arrived");
    expect(endingLabel(interrupted)).toBe("interrupted · the ending never arrived");
  });

  it("shows an ended conversation without an ending as interrupted rather than guessing", () => {
    expect(outcomeOf(conversation({ ...withoutEnding, state: "ended" })).kind).toBe("interrupted");
  });

  it("ends the transcript with the length and how it stopped", () => {
    const end = (overrides: Partial<StoredConversation>) =>
      transcriptEndLine(outcomeOf(conversation(overrides)), 65_000);
    expect(end({ endedBy: "user" })).toBe("1:05 · you ended the conversation");
    expect(end({ endedBy: "agent" })).toBe("1:05 · the agent ended the conversation");
    expect(end({ endedBy: "error", endMessage: "boom" })).toBe("1:05 · ended by an error: boom");
    expect(end({ endedBy: "closed" })).toBe("1:05 · you left the page");
    expect(end({ ...withoutEnding, state: "in-progress" })).toBe("1:05 · the conversation is still in progress");
    expect(end({ ...withoutEnding, state: "interrupted" })).toBe("1:05 · no ending was recorded");
  });
});

describe("median turn", () => {
  it("takes the middle value of an odd number of turns, per stage and end to end", () => {
    const median = medianTurn([
      turn({ llm: 500 }, 1000, 1),
      turn({ llm: 900 }, 3000, 2),
      turn({ llm: 600 }, 1200, 3),
    ]);
    expect(median?.stages.llm).toBe(600);
    expect(median?.totalMs).toBe(1200);
  });

  it("averages the two middle values of an even number of turns", () => {
    expect(medianTurn([turn({ stt: 200 }, 1000), turn({ stt: 300 }, 1400)])?.stages.stt).toBe(250);
  });

  it("leaves out a stage no turn measured, and the speaking stages", () => {
    const median = medianTurn([turn({ llm: 500, capture: 4000, playback: 3000 }, 1000)]);
    expect(Object.keys(median?.stages ?? {})).toEqual(["llm"]);
  });

  it("is null without turns", () => {
    expect(medianTurn([])).toBeNull();
  });

  it("sums tokens and characters over the conversation", () => {
    expect(conversationTotals([turn({}, 1), turn({}, 1)])).toEqual({ llmTokens: 20, ttsChars: 80 });
  });
});
