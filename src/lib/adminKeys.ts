/**
 * Interview key management against the Worker's /admin/keys endpoints.
 *
 * Kept apart from `transport.ts` deliberately: that one carries the candidate's key and is
 * reachable from the page the candidate uses. This one carries the admin password and is
 * only ever imported by the admin route.
 */

export interface InterviewKey {
  token: string;
  label: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AdminClient {
  issue(hours: number, label: string): Promise<InterviewKey>;
  list(): Promise<InterviewKey[]>;
  revoke(token: string): Promise<void>;
}

type FetchLike = typeof fetch;

/** A 401 has to be distinguishable from a network failure: it means a wrong password. */
export class AdminUnauthorized extends Error {
  constructor() {
    super("admin password rejected");
    this.name = "AdminUnauthorized";
  }
}

export function createAdminClient(
  workerUrl: string,
  adminToken: string,
  fetchImpl: FetchLike = fetch,
): AdminClient {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const r = await fetchImpl(`${workerUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
    });
    if (r.status === 401) throw new AdminUnauthorized();
    if (!r.ok) throw new Error(`admin ${path} failed: ${r.status}`);
    return r;
  };

  return {
    issue: async (hours, label) => {
      const r = await call("/admin/keys", {
        method: "POST",
        body: JSON.stringify({ hours, label }),
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
