import {
  requestCode, verifyCode, sessionEmail, listPeople, addPerson, removePerson,
  clientIp, withinLimit, sha256,
} from "./signin.js";

export { AddressGuard } from "./guard.js";

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
    "access-control-allow-headers": "content-type,x-vibe-token,x-admin-token,x-admin-session",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
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

const ENGINES = ["elevenlabs", "deepgram"];
const DEFAULT_ENGINE = "elevenlabs";

const engineOf = (value) => (ENGINES.includes(value) ? value : DEFAULT_ENGINE);

/**
 * The engine an interview key alive in KV is set to, or null for a stranger. Every key
 * carries an expiry; there is no permanent one.
 */
async function caller(token, env) {
  if (!token || !env.KEYS) return null;
  const raw = await env.KEYS.get(`key:${token}`);
  if (raw === null) return null;
  const stored = JSON.parse(raw);
  return { engine: engineOf(stored.engine) };
}

/** Which engine each paid endpoint spends, so a key only reaches the one it is set to. */
const ENDPOINT_ENGINE = { "/agent/token": "elevenlabs", "/deepgram-token": "deepgram" };

/**
 * The shared password, kept for one job only: seeding the allowlist when it is empty,
 * and getting back in if Slack is down. It cannot mint interview keys — otherwise this
 * one static string, which never expires and names nobody, would still be the real
 * credential and the sign-in below would be decoration.
 */
function bootstrapAllowed(req, env) {
  return Boolean(env.ADMIN_TOKEN) && secretEquals(req.headers.get("x-admin-token") ?? "", env.ADMIN_TOKEN);
}

async function issueInterviewKey(req, env, json) {
  const body = await req.json().catch(() => ({}));
  const hours = Number(body.hours) || DEFAULT_TTL_HOURS;
  if (!(hours > 0) || hours > MAX_TTL_HOURS) {
    return json({ error: `hours must be between 0 and ${MAX_TTL_HOURS}` }, 400);
  }

  const label = typeof body.label === "string" ? body.label.slice(0, 80) : "";
  const engine = engineOf(body.engine);
  const token = issuedKey();
  const issuedAt = Date.now();
  // KV refuses a TTL under a minute, so the stored lifetime — not the requested one — is
  // what expiresAt has to describe. Otherwise the page calls a key expired while the
  // Worker still honours it.
  const ttlSeconds = Math.max(MIN_TTL_SECONDS, Math.round(hours * 3600));
  const record = { label, engine, issuedAt, expiresAt: issuedAt + ttlSeconds * 1000 };

  await env.KEYS.put(`key:${token}`, JSON.stringify(record), { expirationTtl: ttlSeconds });

  return json({ token, ...record });
}

/**
 * Moves a live key to the other engine, e.g. when ElevenLabs is down mid-session. The
 * record is rewritten with what is left of its lifetime, so switching never extends a key.
 */
async function setKeyEngine(token, req, env, json) {
  const body = await req.json().catch(() => ({}));
  if (!ENGINES.includes(body.engine)) {
    return json({ error: `engine must be one of ${ENGINES.join(", ")}` }, 400);
  }
  const raw = await env.KEYS.get(`key:${token}`);
  if (raw === null) return json({ error: "no such key" }, 404);
  const stored = JSON.parse(raw);
  const leftSeconds = Math.round(((stored.expiresAt ?? 0) - Date.now()) / 1000);
  if (leftSeconds < MIN_TTL_SECONDS) return json({ error: "key is about to expire" }, 409);
  const record = { ...stored, engine: body.engine };
  await env.KEYS.put(`key:${token}`, JSON.stringify(record), { expirationTtl: leftSeconds });
  return json({ token, engine: record.engine });
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
        engine: engineOf(stored.engine),
        issuedAt: stored.issuedAt ?? 0,
        expiresAt: stored.expiresAt ?? 0,
      };
    }),
  );
  entries.sort((a, b) => b.issuedAt - a.issuedAt);
  return json({ keys: entries });
}

export default {
  async fetch(req, env, ctx) {
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
    // Sign-in by Slack code. Both are open: an address is not a secret, and the
    // answer to a code request is the same for every address — anything else would
    // let a stranger enumerate who has access.
    if (path === "/admin/signin" && req.method === "POST") {
      if (!env.KEYS) return json({ error: "not found" }, 404);
      return requestCode(req, env, json, ctx);
    }
    if (path === "/admin/verify" && req.method === "POST") {
      if (!env.KEYS) return json({ error: "not found" }, 404);
      return verifyCode(req, env, json, ctx);
    }

    if (path.startsWith("/admin/")) {
      if (!env.KEYS) return json({ error: "not found" }, 404);
      const signedIn = await sessionEmail(req, env);
      // Minting keys spends our ElevenLabs quota, so it takes a named person who passed
      // a code. The allowlist itself also answers to the bootstrap password.
      const who = signedIn ?? (path.startsWith("/admin/people") && bootstrapAllowed(req, env)
        ? "bootstrap"
        : null);
      if (!who) return json({ error: "nope" }, 401);

      if (path === "/admin/people") {
        if (req.method === "GET") return listPeople(env, json);
        if (req.method === "POST") return addPerson(req, env, json);
      }
      if (req.method === "DELETE" && path.startsWith("/admin/people/")) {
        return removePerson(decodeURIComponent(path.slice("/admin/people/".length)), env, json);
      }
    }

    if (path.startsWith("/admin/keys")) {

      if (req.method === "POST" && path === "/admin/keys") return issueInterviewKey(req, env, json);
      if (req.method === "GET" && path === "/admin/keys") return listInterviewKeys(env, json);
      if (req.method === "PATCH") {
        const token = decodeURIComponent(path.slice("/admin/keys/".length));
        if (!token) return json({ error: "token required" }, 400);
        return setKeyEngine(token, req, env, json);
      }
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
    if (path !== "/engine" && !Object.hasOwn(ENDPOINT_ENGINE, path)) return json({ error: "not found" }, 404);

    // The address limit comes first so guessing keys costs a stranger as much as using one.
    if (!(await withinLimit(env.TOKEN_IP_LIMIT, clientIp(req)))) {
      return json({ error: "too many requests" }, 429);
    }
    const token = req.headers.get("x-vibe-token") ?? "";
    const who = await caller(token, env);
    if (!who) return json({ error: "nope" }, 401);
    // Hashed so the limiter never holds a live credential; minting shares one budget.
    const bucket = `${path === "/engine" ? "engine" : "mint"}:${await sha256(token)}`;
    // Before the key's budget, so a request the key could never make does not spend it.
    if (ENDPOINT_ENGINE[path] && ENDPOINT_ENGINE[path] !== who.engine) {
      return json({ error: "key is set to another engine" }, 403);
    }
    if (!(await withinLimit(env.TOKEN_KEY_LIMIT, bucket))) {
      return json({ error: "too many requests" }, 429);
    }

    // Asked before every conversation, so a switch in the admin page applies to the next one.
    if (path === "/engine") return json({ engine: who.engine });

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

    // Deepgram's grant lives 30 seconds and is only checked when the socket opens, so it
    // can reach the browser; the API key itself never leaves the Worker.
    if (path === "/deepgram-token") {
      if (!env.DEEPGRAM_API_KEY) return json({ error: "deepgram not configured" }, 503);
      const r = await fetch("https://api.deepgram.com/v1/auth/grant", {
        method: "POST",
        headers: {
          authorization: `Token ${env.DEEPGRAM_API_KEY}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      if (!r.ok) return json({ error: "upstream failed", status: r.status }, 502);
      const body = await r.json();
      return json({ token: body.access_token });
    }

    return json({ error: "not found" }, 404);
  },
};
