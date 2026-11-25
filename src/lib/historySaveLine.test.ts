import { describe, expect, it } from "vitest";
import type { HistoryStatus } from "./history";
import { saveLineText } from "./historySaveLine";

function saved(summary: { endedBy: "user" | "agent" | "error" | "closed"; message?: string }, lengthMs = 408_000): HistoryStatus {
  return { kind: "saved", summary: { lengthMs, ...summary } };
}

describe("saveLineText", () => {
  it("has no line while a segment is being recorded", () => {
    expect(saveLineText({ kind: "recording" })).toBeNull();
  });

  it("says the conversation is being saved while its ending is delivered", () => {
    expect(saveLineText({ kind: "saving" })).toBe("Saving to history…");
  });

  it("gives the length and completed for an ending by the user or the agent", () => {
    expect(saveLineText(saved({ endedBy: "user" }))).toBe("Saved to history — 6:48, completed.");
    expect(saveLineText(saved({ endedBy: "agent" }))).toBe("Saved to history — 6:48, completed.");
  });

  it("gives the message of an error ending, and a fallback when it has none", () => {
    expect(saveLineText(saved({ endedBy: "error", message: "socket closed" }, 5_000))).toBe(
      "Saved to history — 0:05, failed — socket closed.",
    );
    expect(saveLineText(saved({ endedBy: "error" }, 5_000))).toBe("Saved to history — 0:05, failed — unknown error.");
  });

  it("says the user left for a closed ending", () => {
    expect(saveLineText(saved({ endedBy: "closed" }, 5_000))).toBe("Saved to history — 0:05, ended · you left the page.");
  });

  it("tells a refusal from an unreachable server, and only the second sends the visitor to the server", () => {
    const refused = saveLineText({ kind: "notSaved", reason: "refused" });
    const unreachable = saveLineText({ kind: "notSaved", reason: "unreachable" });

    expect(refused).toMatch(/refused/);
    expect(refused).not.toContain("npm run server");
    expect(unreachable).toContain("npm run server");
  });
});
