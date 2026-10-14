/**
 * Interview key management against the Worker's /admin/keys endpoints.
 *
 * Kept apart from `transport.ts` deliberately: that one carries the candidate's key and is
 * reachable from the page the candidate uses. This one carries the admin session and is
 * only ever imported by the admin route.
 */

import type { Engine } from "./pipeline/session";

export interface InterviewKey {
  token: string;
  label: string;
  engine: Engine;
  issuedAt: number;
  expiresAt: number;
}

export interface AdminClient {
  issue(hours: number, label: string, engine?: Engine): Promise<InterviewKey>;
  list(): Promise<InterviewKey[]>;
  revoke(token: string): Promise<void>;
  /** Takes effect from the key's next conversation. */
  setEngine(token: string, engine: Engine): Promise<void>;
}

type FetchLike = typeof fetch;

/** A 401 has to be distinguishable from a network failure: it means a wrong or dead session. */
export class AdminUnauthorized extends Error {
  constructor() {
    super("admin session rejected");
    this.name = "AdminUnauthorized";
  }
}

/** Asks for a Slack code. The answer is the same for any address, so it cannot enumerate us. */
export async function requestCode(
  workerUrl: string,
  email: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await fetchImpl(`${workerUrl}/admin/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

/** Trades the code for a session token, or throws AdminUnauthorized. */
export async function verifyCode(
  workerUrl: string,
  email: string,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const r = await fetchImpl(`${workerUrl}/admin/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (r.status === 401) throw new AdminUnauthorized();
  if (!r.ok) throw new Error(`verify failed: ${r.status}`);
  return ((await r.json()) as { session: string }).session;
}

export function createAdminClient(
  workerUrl: string,
  session: string,
  fetchImpl: FetchLike = fetch,
): AdminClient {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const r = await fetchImpl(`${workerUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-admin-session": session },
    });
    if (r.status === 401) throw new AdminUnauthorized();
    if (!r.ok) throw new Error(`admin ${path} failed: ${r.status}`);
    return r;
  };

  return {
    issue: async (hours, label, engine = "elevenlabs") => {
      const r = await call("/admin/keys", {
        method: "POST",
        body: JSON.stringify({ hours, label, engine }),
      });
      return (await r.json()) as InterviewKey;
    },

    list: async () => {
      const r = await call("/admin/keys", { method: "GET" });
      return ((await r.json()) as { keys: InterviewKey[] }).keys;
    },

    revoke: async (token) => {
      await call(`/admin/keys/${encodeURIComponent(token)}`, { method: "DELETE" });
    },

    setEngine: async (token, engine) => {
      await call(`/admin/keys/${encodeURIComponent(token)}`, {
        method: "PATCH",
        body: JSON.stringify({ engine }),
      });
    },
  };
}

/** "in 3h 40m" — an expiry timestamp is not something to read off a clock mid-interview. */
export function formatRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}
