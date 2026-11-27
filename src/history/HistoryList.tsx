import { useCallback, useRef, useState } from "react";
import type { HistoryApi, StoredConversation } from "../lib/historyApi";
import { historyHref } from "../lib/route";
import {
  formatDay, formatLength, formatTimeRange, lengthMs, outcomeLabel, outcomeOf,
} from "../lib/historyView";
import { ConfirmDelete, TrashIcon, type Removal } from "./ConfirmDelete";
import { useLoad } from "./useLoad";

/** At most one row is being deleted at a time; the id says which. */
type RowRemoval = { kind: "idle" } | (Exclude<Removal, { kind: "idle" }> & { id: string });

/**
 * Pages loaded after the first one. `cursor` undefined means none was loaded yet, so the
 * first page's own `nextCursor` applies; null means the last page is in.
 */
interface OlderPages {
  conversations: StoredConversation[];
  cursor: string | null | undefined;
  status: "idle" | "loading" | "failed";
}

const NO_OLDER_PAGES: OlderPages = { conversations: [], cursor: undefined, status: "idle" };

/** The visitor's conversations, newest first, each one deletable in place. */
export function HistoryList({ api, timeZone }: { api: HistoryApi; timeZone?: string }) {
  const load = useCallback((signal: AbortSignal) => api.list(signal), [api]);
  const { state, reload } = useLoad(load);
  const [removal, setRemoval] = useState<RowRemoval>({ kind: "idle" });
  const [older, setOlder] = useState<OlderPages>(NO_OLDER_PAGES);
  const olderRequestRef = useRef<AbortController | null>(null);

  const showOlder = async (cursor: string) => {
    olderRequestRef.current?.abort();
    const request = new AbortController();
    olderRequestRef.current = request;
    setOlder((pages) => ({ ...pages, status: "loading" }));
    try {
      const page = await api.list(request.signal, cursor);
      if (request.signal.aborted) return;
      setOlder((pages) => ({
        conversations: [...pages.conversations, ...page.conversations],
        cursor: page.nextCursor,
        status: "idle",
      }));
    } catch {
      if (!request.signal.aborted) setOlder((pages) => ({ ...pages, status: "failed" }));
    }
  };

  const remove = async (id: string) => {
    setRemoval({ kind: "deleting", id });
    try {
      await api.remove(id);
      // The totals live on the server, so the list is read again, from its first page.
      olderRequestRef.current?.abort();
      setOlder(NO_OLDER_PAGES);
      await reload();
      setRemoval({ kind: "idle" });
    } catch {
      setRemoval({ kind: "failed", id });
    }
  };

  if (state.kind === "loading") return <p className="history-note">Loading…</p>;
  if (state.kind === "failed") {
    return (
      <p className="history-note" data-failed="true">
        Could not reach the history server. Check that it is running (npm run server).
      </p>
    );
  }

  const { totals } = state.data;
  const conversations = [...state.data.conversations, ...older.conversations];
  const nextCursor = older.cursor === undefined ? state.data.nextCursor : older.cursor;
  return (
    <section className="panel" aria-label="Past conversations">
      <div className="panel-head">
        <span>History</span>
        <span className="spacer" />
        <span>
          <span className="readout">{totals.all}</span> {totals.all === 1 ? "session" : "sessions"}
        </span>
        <span className="history-count" data-outcome="completed">
          {totals.completed} completed
        </span>
        <span className="history-count" data-outcome="failed">
          {totals.failed} failed
        </span>
      </div>

      {conversations.length === 0 ? (
        <p className="history-empty">
          No conversations yet. Each one you hold is kept here with its date, length and
          outcome. <a href="./">Start a conversation</a>
        </p>
      ) : (
        <>
          <div className="history-row history-row-head" aria-hidden="true">
            <span />
            <span>Date</span>
            <span>Time</span>
            <span className="history-num">Length</span>
            <span>Outcome</span>
            <span />
          </div>
          <ol className="history-rows">
            {conversations.map((conversation) => (
              <HistoryRow
                key={conversation.id}
                conversation={conversation}
                timeZone={timeZone}
                removal={removal.kind !== "idle" && removal.id === conversation.id ? removal : null}
                deleteDisabled={removal.kind === "deleting" && removal.id !== conversation.id}
                onAsk={() => setRemoval({ kind: "confirming", id: conversation.id })}
                onCancel={() => setRemoval({ kind: "idle" })}
                onConfirm={() => void remove(conversation.id)}
              />
            ))}
          </ol>
          {nextCursor !== null && (
            <div className="history-more">
              <button
                type="button"
                onClick={() => void showOlder(nextCursor)}
                disabled={older.status === "loading"}
              >
                Show older conversations
              </button>
              {older.status === "failed" && (
                <span className="history-more-failed">Could not load older conversations.</span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function HistoryRow({
  conversation,
  timeZone,
  removal,
  deleteDisabled,
  onAsk,
  onCancel,
  onConfirm,
}: {
  conversation: StoredConversation;
  timeZone?: string;
  removal: Exclude<Removal, { kind: "idle" }> | null;
  /** Another row is being deleted, and only one delete runs at a time. */
  deleteDisabled: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const outcome = outcomeOf(conversation);
  const day = formatDay(conversation.startedAt, timeZone);
  const range = formatTimeRange(conversation, timeZone);
  const length = lengthMs(conversation);

  return (
    <li className="history-row" data-outcome={outcome.kind} data-confirming={removal !== null}>
      <span className="history-mark" aria-hidden="true" />
      <a
        className="history-date"
        href={historyHref(conversation.id)}
        aria-label={`Open conversation of ${day}, ${range}`}
      >
        {day}
      </a>
      <span className="history-time">{range}</span>
      <span className="history-num readout">{formatLength(length)}</span>
      {removal ? (
        <ConfirmDelete
          question="Delete this conversation? This can't be undone."
          removal={removal}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      ) : (
        <>
          <span className="history-outcome">{outcomeLabel(outcome)}</span>
          <button
            type="button"
            className="history-delete"
            aria-label={`Delete conversation of ${day}, ${range}`}
            onClick={onAsk}
            disabled={deleteDisabled}
          >
            <TrashIcon />
          </button>
        </>
      )}
    </li>
  );
}
