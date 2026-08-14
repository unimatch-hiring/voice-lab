import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Admin } from "./Admin";
import { LipSyncBench } from "./bench/LipSyncBench";

// Routes besides the instrument, and no router dependency to serve them: GitHub Pages
// has no rewrites, so /admin is reached as ?admin — a real path would 404 before React runs.
const route = new URLSearchParams(location.search);

createRoot(document.getElementById("root")!).render(
  route.has("admin") ? <Admin /> : route.has("bench") ? <LipSyncBench /> : <App />,
);
