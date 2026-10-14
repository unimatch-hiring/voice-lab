import { guard } from "./guard.js";

/**
 * Admin sign-in by a code sent over Slack.
 *
 * Replaces the shared password: the interviewer types their work email, the bot DMs
 * them a code, they type it. Nothing to remember, nothing to pass between
 * people, and access is revoked one person at a time.
 *
 * The allowlist lives in KV rather than an environment variable — otherwise adding
 * someone would mean a deploy, and the whole point was to stop holding commands in
 * your head.
 */

/**
 * Eight digits, not the customary six: the try cap is per code, so the guess space is what
 * keeps a script that requests code after code from getting anywhere.
 */
const CODE_DIGITS = 8;
/** A session covers a shift: an interview runs 80 minutes, and they come back to back. */
const SESSION_TTL_SECONDS = 12 * 3600;

const normalise = (email) => String(email ?? "").trim().toLowerCase();

export const clientIp = (req) => req.headers.get("cf-connecting-ip") ?? "unknown";

/**
 * Cloudflare's rate limiter, when one is bound. It counts per location and is permissive
 * by design, so it raises the price of guessing rather than capping it. No binding means
 * `wrangler dev` and the tests.
 */
export async function withinLimit(limiter, key) {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A code from a cryptographic source: Math.random is predictable.
 *
 * Values above the last whole multiple of the range are redrawn rather than folded with
 * `%`, which would make the low codes measurably likelier than the high ones.
 */
function digits(count) {
  const range = 10 ** count;
  const ceiling = Math.floor(0xffffffff / range) * range;
  let n;
  do {
    [n] = crypto.getRandomValues(new Uint32Array(1));
  } while (n >= ceiling);
  return String(n % range).padStart(count, "0");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * DMs a person by Slack user ID.
 *
 * By ID rather than by address: resolving an address needs `users:read.email`, and this
 * token is shared with Hermes — addressing the DM directly keeps the only scope we depend
 * on down to `chat:write`.
 */
async function slackDm(env, userId, text) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: userId, text }),
  });
  const sent = await r.json();
  // Undelivered looks exactly like never-requested from the outside, so the reason has to
  // land somewhere. A missing scope cost us an afternoon of silence.
  if (!sent.ok) console.error("slack dm failed", sent.error);
  return sent.ok === true;
}

/** Tells every admin on the list, through the same DM channel the codes use. */
async function alertAdmins(env, text) {
  const { keys } = await env.KEYS.list({ prefix: "admin:" });
  const ids = await Promise.all(keys.map(({ name }) => env.KEYS.get(name)));
  await Promise.all(ids.filter(Boolean).map((id) => slackDm(env, id, text)));
}

/** Runs after the response when the runtime allows, so the caller never waits on Slack. */
async function later(ctx, work) {
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
}

/**
 * Issues a code if the address is on the list.
 *
 * The response is identical either way — different answers would let anyone enumerate who
 * holds admin access, and what leaks then is not passwords but people. Identical bodies
 * are not enough on their own: awaiting Slack would make the listed address answer
 * hundreds of milliseconds slower, so the DM goes out after the response.
 */
export async function requestCode(req, env, json, ctx) {
  const body = await req.json().catch(() => ({}));
  const email = normalise(body.email);
  const same = () => json({ ok: true });
  const ip = clientIp(req);
  // Independent of the address, so answering it early discloses nothing about the list.
  if (!(await withinLimit(env.SIGNIN_IP_LIMIT, ip))) return json({ error: "too many requests" }, 429);
  if (!email.includes("@")) return same();

  // Nothing is read before replying, not even the allowlist. A KV hit and a KV miss cost
  // measurably different amounts — 39ms against 102ms when this was measured — so a lookup
  // here hands out membership by the clock however identical the bodies are.
  const issue = async () => {
    if (!(await withinLimit(env.SIGNIN_LIMIT, email))) return;

    const slackId = await env.KEYS.get(`admin:${email}`);
    if (!slackId) return;

    const code = digits(CODE_DIGITS);
    // The guard keeps a hash: reading its storage must not be enough to sign in.
    const result = await guard(env, email, "issue", { hash: await sha256(`${email}:${code}`) });
    if (!result.issued) console.warn("signin code refused", { email, ip, reason: result.reason });
    if (result.alert) {
      await alertAdmins(env, `voice-lab: ${result.alert} sign-in code requests for ${email} in 10 minutes, latest from ${ip}.`);
    }
    if (result.issued) {
      await slackDm(env, slackId, `voice-lab admin code: *${code}*\nGood for 10 minutes.`);
    }
  };

  if (ctx?.waitUntil) ctx.waitUntil(issue());
  else await issue();
  return same();
}

/** Trades a correct code for a session. The code is single-use. */
export async function verifyCode(req, env, json, ctx) {
  const body = await req.json().catch(() => ({}));
  const email = normalise(body.email);
  const code = String(body.code ?? "").trim();
  const ip = clientIp(req);

  if (!(await withinLimit(env.VERIFY_IP_LIMIT, ip)) || !(await withinLimit(env.VERIFY_LIMIT, email))) {
    console.warn("signin verify limited", { email, ip });
    return json({ error: "too many attempts" }, 429);
  }

  const result = await guard(env, email, "verify", { hash: await sha256(`${email}:${code}`) });
  if (!result.ok) {
    console.warn("signin verify failed", { email, ip, reason: result.reason });
    if (result.alert) {
      await later(ctx, alertAdmins(env, `voice-lab: ${result.alert} wrong sign-in codes for ${email} in 10 minutes, latest from ${ip}.`));
    }
    return json({ error: result.reason === "wrong" ? "wrong code" : "code expired" }, 401);
  }

  const session = randomToken();
  // Hashed for the same reason the code is: KV contents must not be a way in.
  await env.KEYS.put(`sess:${await sha256(session)}`, email, {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return json({ session, email });
}

/**
 * Whose session this is, or null.
 *
 * The allowlist is consulted on every call, not just at sign-in: a session lives twelve
 * hours, and removing someone has to lock them out now rather than by this evening.
 */
export async function sessionEmail(req, env) {
  const token = req.headers.get("x-admin-session") ?? "";
  if (!token || !env.KEYS) return null;
  const email = await env.KEYS.get(`sess:${await sha256(token)}`);
  if (!email) return null;
  return (await env.KEYS.get(`admin:${email}`)) === null ? null : email;
}

/** Who has access — readable and editable only by someone signed in. */
export async function listPeople(env, json) {
  const { keys } = await env.KEYS.list({ prefix: "admin:" });
  const people = await Promise.all(
    keys.map(async ({ name }) => ({
      email: name.slice("admin:".length),
      slack: (await env.KEYS.get(name)) || "",
    })),
  );
  return json({ people });
}

export async function addPerson(req, env, json) {
  const body = await req.json().catch(() => ({}));
  const email = normalise(body.email);
  const slack = String(body.slack ?? "").trim();
  if (!email.includes("@")) return json({ error: "email required" }, 400);
  // The address only names the person; this is where their code actually goes.
  if (!/^[UW][A-Z0-9]{6,}$/.test(slack)) return json({ error: "slack user id required" }, 400);
  await env.KEYS.put(`admin:${email}`, slack);
  return json({ email, slack });
}

export async function removePerson(email, env, json) {
  const key = `admin:${normalise(email)}`;
  if ((await env.KEYS.get(key)) === null) return json({ error: "no such person" }, 404);
  await env.KEYS.delete(key);
  return json({ removed: normalise(email) });
}
