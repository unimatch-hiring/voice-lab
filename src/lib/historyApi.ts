import type { EndedBy } from "../../shared/historyContract.js";
import type { TurnMetrics } from "./types";

/**
 * The read side of the local history server: list, read and delete the conversations kept
 * under this browser's user id. Shapes mirror `server/store.js`.
 */

export interface StoredConversation {
  id: string;
  agentId: string;
  /** Server ms. */
  startedAt: number;
  lastEntryAt: number;
  /** null until the ending arrives, and forever if it never does. */
  endedAt: number | null;
  endedBy: EndedBy | null;
  /**
   * Derived by the server: "ended" once an ending is stored; without one, "in-progress" while
   * the last entry is recent and "interrupted" after that.
   */
  state: "ended" | "in-progress" | "interrupted";
  endMessage: string | null;
  lineCount: number;
  turnCount: number;
}

export interface HistoryTotals {
  all: number;
  completed: number;
  failed: number;
}

export interface ConversationPage {
  conversations: StoredConversation[];
  nextCursor: string | null;
  totals: HistoryTotals;
}

export interface StoredLine {
  seq: number;
  speaker: "user" | "agent";
  text: string;
  /** ms since the conversation started, on the page's clock. */
  atMs: number;
}

export interface StoredTurn {
  seq: number;
  /** When the turn completed, ms since the start. */
  atMs: number;
  metrics: TurnMetrics;
}

export interface ConversationDetail {
  conversation: StoredConversation;
  lines: StoredLine[];
  turns: StoredTurn[];
}

export interface HistoryApi {
  /** `cursor` is a page's `nextCursor`; without one the first page comes back. */
  list(signal?: AbortSignal, cursor?: string): Promise<ConversationPage>;
  get(id: string, signal?: AbortSignal): Promise<ConversationDetail>;
  remove(id: string): Promise<void>;
}

/** The server answered, but not with what was asked for. */
export class HistoryApiError extends Error {
  constructor(readonly status: number) {
    super(`history server answered ${status}`);
    this.name = "HistoryApiError";
  }
}

export interface HistoryApiDeps {
  historyUrl: string;
  userId: string;
  fetch: typeof fetch;
}

/** A server that accepts the connection and never answers must not leave the page waiting. */
export const REQUEST_TIMEOUT_MS = 10_000;

export function createHistoryApi({ historyUrl, userId, fetch }: HistoryApiDeps): HistoryApi {
  // The limit covers reading the body too, so `read` runs before the timer is cleared.
  const request = async <T>(
    path: string,
    init: RequestInit,
    read: (response: Response) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const callerSignal = init.signal;
    const abortLikeCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortLikeCaller();
    else callerSignal?.addEventListener("abort", abortLikeCaller);
    const timer = setTimeout(
      () => controller.abort(new DOMException("history request timed out", "TimeoutError")),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${historyUrl}${path}`, {
        ...init,
        signal: controller.signal,
        // The id is the only key to this history, so it stays out of URLs and logs.
        headers: { "x-history-user": userId },
      });
      if (!response.ok) throw new HistoryApiError(response.status);
      return await read(response);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortLikeCaller);
    }
  };
  const readJson = (response: Response) => response.json();
  const conversationPath = (id: string) => `/conversations/${encodeURIComponent(id)}`;

  return {
    async list(signal, cursor) {
      const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      return request(`/conversations${query}`, { signal }, readJson);
    },
    async get(id, signal) {
      return request(conversationPath(id), { signal }, readJson);
    },
    async remove(id) {
      await request(conversationPath(id), { method: "DELETE" }, async () => undefined);
    },
  };
}
