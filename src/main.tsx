import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Admin } from "./Admin";
import { LipSyncBench } from "./bench/LipSyncBench";
import { HistoryPage } from "./history/HistoryPage";
import { loadConfig } from "./lib/config";
import { createHistoryApi } from "./lib/historyApi";
import { historyIdFrom, pickRoute } from "./lib/route";
import { browserUserId } from "./lib/userId";

// Set by the preview workflows. A convenience only: a pull request can rewrite this file,
// so what keeps previews away from the admin session is that they are served elsewhere.
const preview = import.meta.env.VITE_PREVIEW === "1";

const pages = {
  app: () => <App />,
  admin: () => <Admin />,
  "admin-unavailable": () => <p>The admin page is not available in a preview.</p>,
  bench: () => <LipSyncBench />,
  history: () => <HistoryPage api={browserHistoryApi()} conversationId={historyIdFrom(location.search)} />,
};

function browserHistoryApi() {
  const { historyUrl } = loadConfig();
  if (!historyUrl) return null;
  const userId = browserUserId();
  if (!userId) return null;
  return createHistoryApi({ historyUrl, userId, fetch: (...args) => fetch(...args) });
}

createRoot(document.getElementById("root")!).render(pages[pickRoute(location.search, preview)]());
