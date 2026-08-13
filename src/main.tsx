import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Admin } from "./Admin";

// One route besides the instrument, and no router dependency to serve it: GitHub Pages
// has no rewrites, so /admin is reached as ?admin — a real path would 404 before React runs.
const isAdmin = new URLSearchParams(location.search).has("admin");

createRoot(document.getElementById("root")!).render(isAdmin ? <Admin /> : <App />);
