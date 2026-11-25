/** Where a delete stands. The id-less form serves the conversation page, which has one. */
export type Removal =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "failed" };

/**
 * The confirmation, in place rather than in a dialog, so it is plain which conversation goes.
 * Deleting cannot be undone on the server, hence a confirmation and not an undo.
 */
export function ConfirmDelete({
  question,
  removal,
  onCancel,
  onConfirm,
}: {
  question: string;
  removal: Exclude<Removal, { kind: "idle" }>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const busy = removal.kind === "deleting";
  return (
    <div className="history-confirm" role="group" aria-label="Confirm delete">
      <span className="history-confirm-text">
        {removal.kind === "failed" ? "Could not delete it. Try again?" : question}
      </span>
      <button type="button" className="history-cancel" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      <button type="button" className="history-confirm-delete" onClick={onConfirm} disabled={busy}>
        {busy ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
}

export function TrashIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />
    </svg>
  );
}
