import { useCallback, useMemo, useState } from "react";
import type { ConversationDetail, HistoryApi, StoredLine, StoredTurn } from "../lib/historyApi";
import {
  LATENCY_STAGES, conversationTotals, endingLabel, formatDay, formatLength, formatTimeRange,
  lengthMs, medianTurn, outcomeOf, transcriptEndLine, type Outcome,
} from "../lib/historyView";
import { slowestStage } from "../lib/stageTiming";
import { StageShares } from "../scene/StageShares";
import { ConfirmDelete, type Removal } from "./ConfirmDelete";
import { useLoad } from "./useLoad";

/** One stored conversation: how it went, what each turn cost, and what was said. */
export function ConversationView({
  api,
  conversationId,
  navigate,
  timeZone,
}: {
  api: HistoryApi;
  conversationId: string;
  navigate: (href: string) => void;
  timeZone?: string;
}) {
  const load = useCallback(
    (signal: AbortSignal) => api.get(conversationId, signal),
    [api, conversationId],
  );
  const { state } = useLoad(load);
  const [removal, setRemoval] = useState<Removal>({ kind: "idle" });

  const remove = async () => {
    setRemoval({ kind: "deleting" });
    try {
      await api.remove(conversationId);
      navigate("?history");
    } catch {
      setRemoval({ kind: "failed" });
    }
  };

  if (state.kind === "loading") return <p className="history-note">Loading…</p>;
  if (state.kind === "failed") {
    return (
      <p className="history-note" data-failed="true">
        This conversation is not in your history, or the history server is not running (npm run server).{" "}
        <a href="?history">Back to history</a>
      </p>
    );
  }

  return (
    <ConversationBody
      detail={state.data}
      timeZone={timeZone}
      removal={removal}
      onAsk={() => setRemoval({ kind: "confirming" })}
      onCancel={() => setRemoval({ kind: "idle" })}
      onConfirm={() => void remove()}
    />
  );
}

function ConversationBody({
  detail,
  timeZone,
  removal,
  onAsk,
  onCancel,
  onConfirm,
}: {
  detail: ConversationDetail;
  timeZone?: string;
  removal: Removal;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { conversation, lines, turns } = detail;
  const outcome = outcomeOf(conversation);
  const length = lengthMs(conversation);

  return (
    <>
      <div className="history-title-row">
        <h1 className="history-title">
          {formatDay(conversation.startedAt, timeZone)}, {formatTimeRange(conversation, timeZone)}
        </h1>
        {removal.kind === "idle" && (
          <button type="button" className="history-delete-conversation" onClick={onAsk}>
            Delete conversation
          </button>
        )}
      </div>
      {removal.kind !== "idle" && (
        <ConfirmDelete
          question="Delete this conversation, its transcript and timings? This can't be undone."
          removal={removal}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
      <dl className="history-meta">
        <div className="history-meta-outcome" data-outcome={outcome.kind}>
          <dt className="history-hidden">outcome</dt>
          <dd>
            <span className="history-mark" aria-hidden="true" />
            {endingLabel(outcome)}
          </dd>
        </div>
        <div>
          <dt>length</dt>
          <dd className="readout">{formatLength(length)}</dd>
        </div>
        <div>
          <dt>turns</dt>
          <dd className="readout">{turns.length}</dd>
        </div>
      </dl>

      {turns.length > 0 && <MedianSection turns={turns} />}
      {turns.length > 0 && <TurnsTable turns={turns} />}
      <Transcript lines={lines} outcome={outcome} length={length} />
    </>
  );
}

function MedianSection({ turns }: { turns: StoredTurn[] }) {
  const median = useMemo(() => medianTurn(turns), [turns]);
  if (!median) return null;

  const slowest = slowestStage(median.stages, LATENCY_STAGES);
  const slowestIn = turns.filter((t) => slowestStage(t.metrics.stages, LATENCY_STAGES) === slowest).length;
  const { llmTokens, ttsChars } = conversationTotals(turns);

  return (
    <section className="panel" aria-label="Median turn">
      <div className="panel-body">
        <StageShares
          label="median turn"
          stages={median.stages}
          totalMs={median.totalMs}
          order={LATENCY_STAGES}
          className="history-median"
        >
          {slowest} was the slowest stage in {slowestIn} of {turns.length} turns.{" "}
          {llmTokens} tokens generated, {ttsChars} characters spoken.
        </StageShares>
      </div>
    </section>
  );
}

function TurnsTable({ turns }: { turns: StoredTurn[] }) {
  return (
    <section className="panel history-table-wrap" aria-label="Turns">
      <table className="history-turns">
        <thead>
          <tr>
            <th scope="col">Turn</th>
            <th scope="col">Ended at</th>
            {LATENCY_STAGES.map((stage) => (
              <th scope="col" key={stage}>
                {stage}
              </th>
            ))}
            <th scope="col">Total ms</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((turn, index) => {
            const slowest = slowestStage(turn.metrics.stages, LATENCY_STAGES);
            return (
              <tr key={turn.seq}>
                <th scope="row">{index + 1}</th>
                <td>{formatLength(turn.atMs)}</td>
                {LATENCY_STAGES.map((stage) => {
                  const ms = turn.metrics.stages[stage];
                  return (
                    <td key={stage} data-slowest={stage === slowest}>
                      {ms === undefined ? "—" : Math.round(ms)}
                    </td>
                  );
                })}
                <td className="history-total">{Math.round(turn.metrics.totalMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Transcript({
  lines,
  outcome,
  length,
}: {
  lines: StoredLine[];
  outcome: Outcome;
  length: number;
}) {
  return (
    <section className="panel" aria-label="Transcript">
      <div className="panel-head">
        <span>Transcript</span>
      </div>
      <ol className="history-transcript">
        {lines.map((line) => {
          const who = line.speaker === "user" ? "you" : "agent";
          return (
            <li key={line.seq} className="line history-transcript-line" data-who={who}>
              <span className="history-line-at readout">{formatLength(line.atMs)}</span>
              <span className="line-who">{who}</span>
              <span className="line-text">{line.text}</span>
            </li>
          );
        })}
        <li className="history-end" data-outcome={outcome.kind}>
          {transcriptEndLine(outcome, length)}
        </li>
      </ol>
    </section>
  );
}
