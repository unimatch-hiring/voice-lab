import { useEffect, useMemo, useState } from "react";
import { App } from "./App";
import { History } from "./History";
import { historyBaseUrl } from "./lib/historyApi";
import { createHistoryCapture } from "./lib/historyCapture";
import { createHistoryWriteQueue } from "./lib/historyWriteQueue";

function isHistoryPage() {
  return new URLSearchParams(location.search).has("history");
}

export function VoiceLab() {
  const [historyOpen, setHistoryOpen] = useState(isHistoryPage);
  const [dialogueId, setDialogueId] = useState(() =>
    isHistoryPage() ? null : crypto.randomUUID(),
  );
  const [historyWarning, setHistoryWarning] = useState<string | null>(null);
  const [historyWrites] = useState(() =>
    historyBaseUrl() ? createHistoryWriteQueue(setHistoryWarning) : null,
  );
  const warning = historyWrites ? historyWarning : "History is unavailable on this site.";
  const historyCapture = useMemo(
    () => (dialogueId && historyWrites ? createHistoryCapture(dialogueId, historyWrites.enqueue) : null),
    [dialogueId, historyWrites],
  );

  useEffect(() => {
    historyWrites?.start();
    return historyWrites?.stop;
  }, [historyWrites]);

  function showPage(open: boolean) {
    if (!open) setDialogueId((current) => current ?? crypto.randomUUID());
    setHistoryOpen(open);
  }

  useEffect(() => {
    const onPopState = () => showPage(isHistoryPage());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(open: boolean) {
    const url = new URL(location.href);
    if (open) url.searchParams.set("history", "");
    else url.searchParams.delete("history");
    history.pushState(null, "", url);
    showPage(open);
  }

  return (
    <>
      {dialogueId && (
        <div hidden={historyOpen}>
          <App
            historyCapture={historyCapture}
            historyWarning={warning}
            onOpenHistory={() => navigate(true)}
          />
        </div>
      )}
      {historyOpen && (
        <History
          currentDialogueId={dialogueId}
          saveWarning={warning}
          available={historyWrites !== null}
          onBack={() => navigate(false)}
        />
      )}
    </>
  );
}
