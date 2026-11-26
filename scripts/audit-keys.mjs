#!/usr/bin/env node
/**
 * Prints the live interview keys: masked key, label, time left, LLM spend. Reads only.
 * Revoking stays on the admin page, where a person looks at what they are revoking.
 *
 *   node scripts/audit-keys.mjs you@unimatch.ai     # asks for the Slack code
 *   VOICE_LAB_ADMIN_SESSION=… node scripts/audit-keys.mjs
 *
 * The session goes in the environment, not argv: argv is visible to every process on the box.
 */

import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const WORKER_URL = process.env.WORKER_URL ?? "https://voice-lab-token-minter.shupilkin.workers.dev";
// The admin API answers ALLOWED_ORIGINS only, browser or not.
const ORIGIN = process.env.ADMIN_ORIGIN ?? "https://unimatch-hiring.github.io";

/** Flags worth acting on, in the order an auditor reads them. */
export function concerns(key, now) {
  const out = [];
  if (!key.label) out.push("no label");
  if (key.expiresAt - key.issuedAt > 8 * 3600_000) out.push("issued for over 8h");
  if (key.budgetUsd !== undefined && (key.spentUsd ?? 0) >= key.budgetUsd * 0.8) out.push("near LLM budget");
  if (key.expiresAt <= now) out.push("past expiry");
  return out;
}

const left = (expiresAt, now) => {
  const minutes = Math.max(0, Math.round((expiresAt - now) / 60_000));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

const usd = (n) => (n === undefined ? "-" : `$${n.toFixed(2)}`);

/** One line per key. Only what the admin API returns: the hint, never the key. */
export function auditLines(keys, now) {
  if (keys.length === 0) return ["no live keys"];
  const rows = keys.map((k) => [
    k.hint,
    k.label || "-",
    left(k.expiresAt, now),
    `${usd(k.spentUsd)} / ${usd(k.budgetUsd)}`,
    concerns(k, now).join(", "),
  ]);
  const header = ["key", "label", "left", "llm spent", "check"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...rows.map(line), `${keys.length} live key(s)`];
}

async function call(path, init = {}) {
  const r = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin: ORIGIN, ...init.headers },
  });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}

async function signIn(email) {
  await call("/admin/signin", { method: "POST", body: JSON.stringify({ email }) });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const code = (await rl.question("Code from Slack: ")).trim();
  rl.close();
  const { session } = await call("/admin/verify", { method: "POST", body: JSON.stringify({ email, code }) });
  return session;
}

async function main() {
  const given = process.env.VOICE_LAB_ADMIN_SESSION;
  const email = process.argv[2];
  if (!given && !email) {
    console.error("usage: node scripts/audit-keys.mjs <work email>  (or set VOICE_LAB_ADMIN_SESSION)");
    process.exit(2);
  }
  const session = given ?? (await signIn(email));
  try {
    const { keys } = await call("/admin/keys", { headers: { "x-admin-session": session } });
    for (const line of auditLines(keys, Date.now())) console.log(line);
  } finally {
    // A session this script opened is closed by it, so nothing usable is left behind.
    if (!given) await call("/admin/signout", { method: "POST", headers: { "x-admin-session": session } });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
