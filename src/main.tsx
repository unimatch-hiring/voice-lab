import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Admin } from "./Admin";
import { LipSyncBench } from "./bench/LipSyncBench";
import { pickRoute, routeHref } from "./lib/route";
import { AlertsPage } from "./parent/AlertsPage";
import { ParentControl } from "./parent/ParentControl";
import "./parent/parent-control.css";

const App = lazy(() => import("./App").then(({ App }) => ({ default: App })));

// Set by the preview workflows. A convenience only: a pull request can rewrite this file,
// so what keeps previews away from the admin session is that they are served elsewhere.
const preview = import.meta.env.VITE_PREVIEW === "1";
const route = pickRoute(location.search, preview);

if (route.page === "parent") {
  if (route.redirect) history.replaceState(history.state, "", routeHref("parent"));
  document.title = "Child profiles · voice-lab";
} else if (route.page === "alerts") {
  document.title = "Alerts · voice-lab";
}

function invalidLink(kind: "child" | "parent") {
  return (
    <main className="shell">
      <h1>Invalid {kind} link</h1>
      <a href={import.meta.env.BASE_URL}>Open voice-lab</a>
    </main>
  );
}

const pages = {
  admin: <Admin />,
  "admin-unavailable": <p>The admin page is not available in a preview.</p>,
  bench: <LipSyncBench />,
  parent: <ParentControl />,
  alerts: <AlertsPage />,
  "invalid-child": invalidLink("child"),
  "invalid-parent": invalidLink("parent"),
};

createRoot(document.getElementById("root")!).render(
  route.page === "app" ? (
    <Suspense fallback={<p role="status">Loading voice-lab…</p>}>
      <App childId={route.childId} recording={route.recording} />
    </Suspense>
  ) : pages[route.page],
);
