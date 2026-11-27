import { useMemo } from "react";
import { loadConfig } from "../lib/config";
import { routeHref } from "../lib/route";
import { AlertList } from "./AlertList";
import { parentApi } from "./api";

export function AlertsPage({
  serverUrl = loadConfig().childServerUrl, fetchImpl = fetch,
}: { serverUrl?: string; fetchImpl?: typeof fetch } = {}) {
  const api = useMemo(() => parentApi(serverUrl, fetchImpl), [serverUrl, fetchImpl]);

  return (
    <main className="shell parent-shell">
      <header className="masthead">
        <a href={routeHref("parent")}>Child profiles</a>
        <h1>Alerts</h1>
      </header>
      {serverUrl ? <AlertList api={api} /> : (
        <p role="status">Set the server URL to view alerts.</p>
      )}
    </main>
  );
}
