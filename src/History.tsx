import { useEffect, useState } from "react";
import {
  deleteDialogue,
  historySavedEvent,
  listDialogues,
  readDialogue,
  type Dialogue,
  type DialogueSummary,
  type HistoryListing,
} from "./lib/historyApi";
import "./scene/tokens.css";
import "./history.css";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const endings: Record<NonNullable<DialogueSummary["endReason"]>, string> = {
  user: "Stopped by user",
  agent: "Ended by agent",
  error: "Conversation failed",
};

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} sec`;
  return seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`;
}

function HistoryReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="history-actions history-read-error">
      <p className="status-line" role="alert">{message}</p>
      <button className="history-button" type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

function HistoryTranscript({ id, revision }: { id: string; revision: number }) {
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const request = new AbortController();
    void readDialogue(id, request.signal).then(
      (value) => {
        if (request.signal.aborted) return;
        setDialogue(value);
        setFailed(false);
      },
      () => { if (!request.signal.aborted) setFailed(true); },
    );
    return () => request.abort();
  }, [id, revision, attempt]);

  function retry() {
    setDialogue(null);
    setFailed(false);
    setAttempt((current) => current + 1);
  }

  return (
    <section className="panel" id="history-transcript" aria-labelledby="history-transcript-title">
      <h2 className="panel-head history-panel-title" id="history-transcript-title">Transcript</h2>
      <div className="panel-body">
        {failed && <HistoryReadError message="Couldn’t load this transcript." onRetry={retry} />}
        {!failed && !dialogue && <p className="history-note" role="status">Loading transcript…</p>}
        {dialogue && (
          <ol className="history-utterances">
            {dialogue.sessions.flatMap((session) =>
              session.messages.map((message) => (
                <li key={`${session.id}:${message.seq}`}>
                  <span>{message.speaker === "user" ? "User" : "Agent"}</span>
                  <p>{message.text}</p>
                </li>
              )),
            )}
          </ol>
        )}
      </div>
    </section>
  );
}

function DeleteDialogue({ id, onDeleted }: { id: string; onDeleted: (id: string) => void }) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function confirmDelete() {
    setDeleting(true);
    setFailed(false);
    try {
      await deleteDialogue(id);
      onDeleted(id);
    } catch {
      setFailed(true);
    } finally {
      setDeleting(false);
    }
  }

  function cancelDelete() {
    setConfirmationOpen(false);
    setFailed(false);
  }

  if (!confirmationOpen) {
    return (
      <button className="history-button history-danger" type="button" onClick={() => setConfirmationOpen(true)}>
        Delete
      </button>
    );
  }

  return (
    <div className="history-confirm">
      <span>Delete dialogue?</span>
      <div className="history-actions">
        <button className="history-button" type="button" disabled={deleting} onClick={cancelDelete}>
          Cancel
        </button>
        <button className="history-button history-danger" type="button" disabled={deleting} onClick={confirmDelete}>
          {deleting ? "Deleting…" : "Confirm delete"}
        </button>
      </div>
      {failed && <p className="status-line" role="alert">Couldn’t delete this dialogue. Try again.</p>}
    </div>
  );
}

export function History({ currentDialogueId, onBack, saveWarning, available = true }: {
  available?: boolean;
  currentDialogueId: string | null;
  onBack: () => void;
  saveWarning?: string | null;
}) {
  const [listing, setListing] = useState<HistoryListing | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [listAttempt, setListAttempt] = useState(0);
  const dialogues = listing?.dialogues;

  useEffect(() => {
    const refresh = () => setRevision((current) => current + 1);
    window.addEventListener(historySavedEvent, refresh);
    return () => window.removeEventListener(historySavedEvent, refresh);
  }, []);

  useEffect(() => {
    if (!available) return;
    const request = new AbortController();
    void listDialogues(request.signal).then(
      (value) => {
        if (request.signal.aborted) return;
        setListing(value);
        setFailed(false);
      },
      () => { if (!request.signal.aborted) setFailed(true); },
    );
    return () => request.abort();
  }, [revision, listAttempt, available]);

  function retry() {
    setListing(null);
    setFailed(false);
    setListAttempt((current) => current + 1);
  }

  function removeRow(id: string) {
    setListing((current) => current && {
      ...current,
      dialogues: current.dialogues.filter((item) => item.id !== id),
    });
    setSelectedId((selected) => selected === id ? null : selected);
    setRevision((current) => current + 1);
  }

  return (
    <main className="shell">
      <header className="masthead history-header">
        <h1>History</h1>
        <button className="history-button history-back" type="button" onClick={onBack}>Back to voice-lab</button>
      </header>
      {saveWarning && <p className="status-line history-save-warning" role="status">{saveWarning}</p>}
      <section className="panel" aria-labelledby="history-dialogues-title">
        <h2 className="panel-head history-panel-title" id="history-dialogues-title">Dialogues</h2>
        <div className="panel-body">
          {failed && <HistoryReadError message="Couldn’t load history." onRetry={retry} />}
          {available && !failed && !listing && <p className="history-note" role="status">Loading history…</p>}
          {!failed && listing?.incomplete && (
            <p className="status-line history-partial" role="status">Some dialogues couldn’t be loaded.</p>
          )}
          {!failed && !listing?.incomplete && dialogues?.length === 0 && (
            <p className="history-note">No dialogues yet.</p>
          )}
          {!!dialogues?.length && (
            <ul className="history-list">
              {dialogues.map((dialogue) => (
                <li className="history-row" key={dialogue.id}>
                  <div>
                    <time dateTime={dialogue.startedAt}>{dateTime.format(new Date(dialogue.startedAt))}</time>
                    <p className="history-note history-summary">
                      <span>{formatDuration(dialogue.durationMs)}</span>
                      <span>{dialogue.endReason ? endings[dialogue.endReason] : "No ending recorded"}</span>
                    </p>
                  </div>
                  <div className="history-actions">
                    <button
                      className="history-button"
                      type="button"
                      aria-pressed={selectedId === dialogue.id}
                      onClick={() => setSelectedId(dialogue.id)}
                    >
                      Open transcript
                    </button>
                    {currentDialogueId !== dialogue.id && <DeleteDialogue id={dialogue.id} onDeleted={removeRow} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {selectedId && <HistoryTranscript key={selectedId} id={selectedId} revision={revision} />}
    </main>
  );
}
