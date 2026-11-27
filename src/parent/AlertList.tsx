import { useEffect, useState } from "react";
import type { AlertPage, ReviewAlert } from "../../shared/parent";
import type { parentApi } from "./api";

const severityLabels = { 1: "Low severity", 2: "Medium severity", 3: "High severity" };
const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

function AlertEntry({ item, inProfile }: { item: ReviewAlert; inProfile: boolean }) {
  const Heading = inProfile ? "h3" : "h2";
  const includesMessage = item.findings.some(({ evidence }) =>
    evidence.source === "input" && evidence.quote === item.question);
  return (
    <li>
      <div className="parent-alert-meta">
        {item.severity === 3 && (
          <strong className="alert-attention"><span aria-hidden="true">!</span> Needs attention</strong>
        )}
        {!inProfile && <strong>{item.childName}</strong>}
        <time dateTime={item.occurredAt}>{date.format(new Date(item.occurredAt))}</time>
      </div>
      {item.findings.map((finding) => (
        <div key={finding.kind + (finding.rule?.id ?? "")} className="alert-reason">
          <p className="alert-classification">
            <strong>{finding.kind === "concern" ? "Safety concern" : "Forbidden topic"}</strong>
            {finding.rule && <span>{finding.rule.label}</span>}
            <span data-severity={finding.severity}>{severityLabels[finding.severity]}</span>
          </p>
          <Heading>{finding.description}</Heading>
          <blockquote>
            <span>{finding.evidence.source === "input" ? "Child" : "Agent"} · </span>
            {"“" + finding.evidence.quote + "”"}
          </blockquote>
        </div>
      ))}
      {!includesMessage && <p className="alert-message"><span>Child’s message · </span>{item.question}</p>}
    </li>
  );
}

export function AlertList({
  api, childId, onRead,
}: {
  api: ReturnType<typeof parentApi>;
  childId?: string;
  onRead?: () => void;
}) {
  const [items, setItems] = useState<ReviewAlert[]>([]);
  const [page, setPage] = useState<AlertPage>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reading, setReading] = useState<"idle" | "pending" | "error">("idle");
  const [readRetry, setReadRetry] = useState(0);

  useEffect(() => {
    const stop = new AbortController();
    setLoading(true);
    setLoadError(false);
    api.alerts(childId, cursor, stop.signal)
      .then((next) => {
        if (stop.signal.aborted) return;
        setItems((previous) => cursor ? [...previous, ...next.items] : next.items);
        setPage(next);
      })
      .catch(() => { if (!stop.signal.aborted) setLoadError(true); })
      .finally(() => { if (!stop.signal.aborted) setLoading(false); });
    return () => stop.abort();
  }, [api, childId, cursor, retry]);

  useEffect(() => {
    const turnIds = page?.items.filter((item) => item.seenAt === null).map((item) => item.turnId);
    if (!turnIds?.length) return;
    let mounted = true;
    setReading("pending");
    api.markAlertsSeen(turnIds).then(() => {
      if (mounted) setReading("idle");
      onRead?.();
    }).catch(() => { if (mounted) setReading("error"); });
    return () => { mounted = false; };
  }, [api, onRead, page, readRetry]);

  return (
    <section className="panel parent-alerts" aria-label="Alerts">
      {childId && <h2 className="parent-alert-title">Alerts</h2>}
      {items.length > 0 && (
        <ol>
          {items.map((item) => (
            <AlertEntry key={item.turnId} item={item} inProfile={Boolean(childId)} />
          ))}
        </ol>
      )}
      {loading && <p role="status">Loading alerts…</p>}
      {page && items.length === 0 && !loading && (
        <p className="parent-muted">No alerts yet.</p>
      )}
      {loadError && (
        <p role="alert">Could not load alerts.{" "}
          <button className="parent-button" type="button" onClick={() => setRetry(retry + 1)}>Retry</button>
        </p>
      )}
      {reading === "error" && (
        <p role="alert">Could not mark alerts as read.{" "}
          <button className="parent-button" type="button" onClick={() => setReadRetry(readRetry + 1)}>Retry</button>
        </p>
      )}
      {!loading && !loadError && page?.nextCursor && (
        <button className="parent-button" type="button" disabled={reading !== "idle"}
          onClick={() => setCursor(page.nextCursor)}>Show older alerts</button>
      )}
    </section>
  );
}
