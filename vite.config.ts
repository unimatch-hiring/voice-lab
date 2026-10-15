import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Set by `npm run dev:local`: the deployed Worker mints the session, the local one serves
// training questions, which need no provider key.
// The proxy sits under base: the dev server answers nothing outside it.
const deployedWorker = process.env.VOICE_LAB_WORKER_PROXY;
const base = process.env.BASE_PATH ?? "/voice-lab/";
const toWorker = (target: string) => ({
  target,
  changeOrigin: true,
  rewrite: (p: string) => p.slice(`${base}worker`.length),
});

// Dev server on :5173. base is the GitHub Pages sub-path — a branch preview lives one
// level deeper, so the path comes from the build rather than being fixed here.
export default defineConfig({
  base,
  plugins: [react()],
  server: deployedWorker
    ? {
        proxy: {
          [`${base}worker/questions`]: toWorker("http://localhost:8787"),
          [`${base}worker`]: toWorker(deployedWorker),
        },
      }
    : undefined,
  // An agent harness can put a worktree — with its own copy of every test — inside the
  // repo. Without this the suite collects those too and reports failures nobody wrote.
  test: {
    environment: "jsdom",
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
