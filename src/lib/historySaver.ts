import type { EventBus } from "./events";
import { HistoryStream } from "./history";
import type { EndedBy, HistoryStatus } from "./history";
import type { TurnMetrics } from "./types";

/**
 * Owns the history stream of one page visit: End followed by Start continues the same
 * conversation, so there is one stream and one line for the page to show.
 */

export interface SaveLine {
  /** Stable React key: one per stream, so a conversation started after a refusal is a new line. */
  key: number;
  status: HistoryStatus;
}

export interface HistorySaverDeps {
  bus: EventBus;
  /** Null: record nothing. */
  historyUrl: string | null;
  /** Null: record nothing. */
  userId: string | null;
  fetch: typeof fetch;
  now?: () => number;
  onLines: (lines: SaveLine[]) => void;
}

/** `status` stays null until the stream reports. */
interface Conversation {
  key: number;
  stream: HistoryStream;
  status: HistoryStatus | null;
}

export class HistorySaver {
  private conversation: Conversation | null = null;
  private nextKey = 0;
  private lastLines: SaveLine[] = [];
  private disposed = false;

  constructor(private deps: HistorySaverDeps) {}

  start(): void {
    // A refusal is final for its stream, so the next Start is a new conversation; every other stream resumes by itself on the bus's next conversation-start.
    if (this.isRefused(this.conversation)) {
      this.conversation.stream.dispose();
      this.conversation = null;
    }
    if (!this.conversation && this.deps.historyUrl && this.deps.userId) {
      this.conversation = this.createConversation(this.deps.historyUrl, this.deps.userId);
    }
    this.publish();
  }

  addTurn(metrics: TurnMetrics): void {
    this.conversation?.stream.addTurn(metrics);
  }

  end(endedBy: EndedBy, message?: string): void {
    this.conversation?.stream.end(endedBy, message);
  }

  flushOnPageHide(): void {
    this.conversation?.stream.flushOnPageHide();
  }

  dispose(): void {
    this.disposed = true;
    this.conversation?.stream.dispose();
    this.conversation = null;
  }

  private isRefused(conversation: Conversation | null): conversation is Conversation {
    return conversation?.status?.kind === "notSaved" && conversation.status.reason === "refused";
  }

  private createConversation(historyUrl: string, userId: string): Conversation {
    const conversation: Conversation = {
      key: this.nextKey++,
      status: null,
      stream: new HistoryStream({
        bus: this.deps.bus,
        historyUrl,
        userId,
        fetch: this.deps.fetch,
        now: this.deps.now,
        onStatus: (status) => {
          conversation.status = status;
          this.publish();
        },
      }),
    };
    return conversation;
  }

  /** Reports the lines only when they differ from the last report. */
  private publish(): void {
    if (this.disposed) return;
    const lines = this.conversation?.status ? [{ key: this.conversation.key, status: this.conversation.status }] : [];
    if (sameLines(lines, this.lastLines)) return;
    this.lastLines = lines;
    this.deps.onLines(lines);
  }
}

function sameLines(a: SaveLine[], b: SaveLine[]): boolean {
  return a.length === b.length && a.every((line, i) => line.key === b[i].key && line.status === b[i].status);
}
