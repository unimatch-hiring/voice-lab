import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server on :5173. base is the GitHub Pages sub-path — a branch preview lives one
// level deeper, so the path comes from the build rather than being fixed here.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/voice-lab/",
  plugins: [react()],
  // An agent harness can put a worktree — with its own copy of every test — inside the
  // repo. Without this the suite collects those too and reports failures nobody wrote.
  test: {
    environment: "jsdom",
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
