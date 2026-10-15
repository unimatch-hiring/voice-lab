/**
 * One command for a local coach with an interview key, VIBE_TOKEN in worker/.dev.vars. The
 * deployed Worker mints the session; the local one serves the training questions, which
 * need no provider key and may not be deployed yet.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const path = (p) => new URL(p, root);
const WRANGLER = ["--yes", "wrangler@4"];

let devVars = "";
try {
  devVars = readFileSync(path("worker/.dev.vars"), "utf8");
} catch {
  // Missing file reads as a missing key.
}
const vibeToken = devVars.match(/^VIBE_TOKEN=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
if (!vibeToken) {
  console.error("Впишите интервью-ключ в worker/.dev.vars: VIBE_TOKEN=vibe_...");
  process.exit(1);
}

console.log("Локальный ключ доступа…");
// Piped, not inherited: wrangler echoes the key it writes.
const put = spawnSync(
  "npx",
  [...WRANGLER, "kv", "key", "put", "--binding", "KEYS", "--local", `key:${vibeToken}`, JSON.stringify({ engine: "elevenlabs", label: "local" })],
  { cwd: path("worker"), encoding: "utf8" },
);
if (put.status !== 0) {
  console.error(put.stderr.replaceAll(vibeToken, "<key>"));
  process.exit(put.status ?? 1);
}

const deployedWorker = readFileSync(path("src/lib/config.ts"), "utf8").match(/DEFAULT_WORKER_URL = "([^"]+)"/)[1];

const children = [
  spawn("npx", [...WRANGLER, "dev", "--port", "8787"], { cwd: path("worker"), stdio: "inherit" }),
  spawn("npx", ["vite"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_WORKER_URL: `${process.env.BASE_PATH ?? "/voice-lab/"}worker`,
      VOICE_LAB_WORKER_PROXY: deployedWorker,
      VITE_VIBE_TOKEN: vibeToken,
    },
  }),
];
console.log("\nОткройте http://localhost:5173/voice-lab/ — токен уже подставлен, тема «Тренер интеллектуальных игр».\n");

const stop = () => children.forEach((c) => c.kill("SIGINT"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", stop);
