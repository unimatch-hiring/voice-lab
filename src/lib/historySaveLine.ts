import type { HistoryStatus, HistorySummary } from "./history";
import { formatLength, outcomeLabel } from "./historyView";
import type { Outcome } from "./historyView";

/** The page words an ending the same way the history list does. */
function outcomeOfSummary(summary: HistorySummary): Outcome {
  switch (summary.endedBy) {
    case "error":
      return { kind: "failed", message: summary.message ?? "unknown error" };
    case "closed":
      return { kind: "closed" };
    case "user":
    case "agent":
      return { kind: "completed", endedBy: summary.endedBy };
  }
}

/** The line under the start button; null while a segment is being recorded, when there is nothing to report. */
export function saveLineText(status: HistoryStatus): string | null {
  switch (status.kind) {
    case "recording":
      return null;
    case "saving":
      return "Saving to history…";
    case "saved":
      return `Saved to history — ${formatLength(status.summary.lengthMs)}, ${outcomeLabel(outcomeOfSummary(status.summary))}.`;
    case "notSaved":
      return status.reason === "refused"
        ? "This conversation was not saved to history: the history server refused it."
        : "This conversation was not saved to history. Check that the history server is running (npm run server).";
  }
}
