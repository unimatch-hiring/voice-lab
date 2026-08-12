/**
 * ALLOWED_ORIGINS is a comma-separated list in an environment variable, e.g.:
 *   "https://unimatch-hiring.github.io,http://localhost:5173"
 * We echo the request Origin back instead of writing `*`, so `Vary: Origin` is
 * mandatory: without it a CDN can serve a cached header to a different origin.
 */
function corsHeaders(req, env) {
  const origin = req.headers.get("origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!allowed.includes(origin)) return null;

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type,x-vibe-token,x-admin-token",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-max-age": "86400", // a day: no preflight on every request
    vary: "Origin",
  };
}

/** Interview keys are issued for hours, not days: a session is ~80 minutes. */
const DEFAULT_TTL_HOURS = 4;
const MAX_TTL_HOURS = 24;
// Cloudflare rejects an expirationTtl below 60 seconds.
const MIN_TTL_SECONDS = 60;

function issuedKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const body = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `vibe_${body}`;
}

/**
 * Timing-safe string comparison. `===` on secrets leaks their length and first
 * differing byte through response timing, which is enough to guess a token
 * byte by byte against a Worker that answers in milliseconds.
 */
function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/**
 * Who may mint ElevenLabs session tokens: the permanent VIBE_TOKEN, or an
 * interview key still alive in KV. The permanent one is checked first so the
 * deployed site and local dev keep working with no KV namespace bound at all.
 */
async function callerAllowed(req, env) {
  const token = req.headers.get("x-vibe-token") ?? "";
  if (!token) return false;
  if (env.VIBE_TOKEN && secretEquals(token, env.VIBE_TOKEN)) return true;
  if (!env.KEYS) return false;
  return (await env.KEYS.get(`key:${token}`)) !== null;
}

/** Admin endpoints answer only to ADMIN_TOKEN — never to a key we handed a candidate. */
function adminAllowed(req, env) {
  return Boolean(env.ADMIN_TOKEN) && secretEquals(req.headers.get("x-admin-token") ?? "", env.ADMIN_TOKEN);
}

async function issueInterviewKey(req, env, json) {
  const body = await req.json().catch(() => ({}));
  const hours = Number(body.hours) || DEFAULT_TTL_HOURS;
  if (!(hours > 0) || hours > MAX_TTL_HOURS) {
    return json({ error: `hours must be between 0 and ${MAX_TTL_HOURS}` }, 400);
  }

  const label = typeof body.label === "string" ? body.label.slice(0, 80) : "";
  const token = issuedKey();
  const issuedAt = Date.now();
  // KV refuses a TTL under a minute, so the stored lifetime — not the requested one — is
  // what expiresAt has to describe. Otherwise the page calls a key expired while the
  // Worker still honours it.
  const ttlSeconds = Math.max(MIN_TTL_SECONDS, Math.round(hours * 3600));
  const record = { label, issuedAt, expiresAt: issuedAt + ttlSeconds * 1000 };

  await env.KEYS.put(`key:${token}`, JSON.stringify(record), { expirationTtl: ttlSeconds });

  return json({ token, ...record });
}

async function listInterviewKeys(env, json) {
  const { keys } = await env.KEYS.list({ prefix: "key:" });
  const entries = await Promise.all(
    keys.map(async ({ name }) => {
      const raw = await env.KEYS.get(name);
      const stored = raw ? JSON.parse(raw) : {};
      // Defaults rather than a spread of whatever is stored: a record written by an older
      // version, or a hand-made KV entry, otherwise reaches the page without expiresAt and
      // renders as "NaNm left".
      return {
        token: name.slice("key:".length),
        label: stored.label ?? "",
        issuedAt: stored.issuedAt ?? 0,
        expiresAt: stored.expiresAt ?? 0,
      };
    }),
  );
  entries.sort((a, b) => b.issuedAt - a.issuedAt);
  return json({ keys: entries });
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...(cors ?? {}) },
      });

    // Unknown origin: we do not confirm the preflight, the browser blocks the
    // request itself. A body without CORS headers is unreadable to the caller anyway.
    if (!cors) return json({ error: "origin not allowed" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const path = new URL(req.url).pathname;

    // Interview key management. Guarded by ADMIN_TOKEN, and answers 404 without a KV
    // namespace so a deployment that never bound one does not advertise the feature.
    if (path.startsWith("/admin/keys")) {
      if (!env.KEYS) return json({ error: "not found" }, 404);
      if (!adminAllowed(req, env)) return json({ error: "nope" }, 401);

      if (req.method === "POST" && path === "/admin/keys") return issueInterviewKey(req, env, json);
      if (req.method === "GET" && path === "/admin/keys") return listInterviewKeys(env, json);
      if (req.method === "DELETE") {
        // The client percent-encodes the token, so the raw pathname would delete a key
        // spelled differently from the one that exists.
        const token = decodeURIComponent(path.slice("/admin/keys/".length));
        if (!token) return json({ error: "token required" }, 400);
        // Reported rather than assumed: KV deletes a missing key without complaint, and a
        // revocation that quietly did nothing would leave a working credential behind.
        const existed = (await env.KEYS.get(`key:${token}`)) !== null;
        if (!existed) return json({ error: "no such key" }, 404);
        await env.KEYS.delete(`key:${token}`);
        return json({ revoked: token });
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!(await callerAllowed(req, env))) return json({ error: "nope" }, 401);

    // Session token for ElevenLabs Agents: short-lived and scoped to one conversation, so
    // it can safely reach the browser. The API key never leaves the Worker.
    if (path === "/agent/token") {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${env.AGENT_ID}`,
        { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } },
      );
      if (!r.ok) return json({ error: "upstream failed", status: r.status }, 502);
      const body = await r.json();
      return json({ token: body.token, agentId: env.AGENT_ID });
    }

    return json({ error: "not found" }, 404);
  },
};
