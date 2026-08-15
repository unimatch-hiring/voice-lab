/**
 * Admin sign-in by a code sent over Slack.
 *
 * Replaces the shared password: the interviewer types their work email, the bot DMs
 * them six digits, they type those. Nothing to remember, nothing to pass between
 * people, and access is revoked one person at a time.
 *
 * The allowlist lives in KV rather than an environment variable — otherwise adding
 * someone would mean a deploy, and the whole point was to stop holding commands in
 * your head.
 */

/** Ten minutes is enough to walk to Slack and back. */
const CODE_TTL_SECONDS = 600;
/**
 * Eight, not the customary six: the try cap below is a KV read-modify-write, which is not
 * atomic, so parallel guesses each get a free try and the guess space has to carry this
 * on its own. A million is reachable by script; a hundred million is not.
 */
const CODE_DIGITS = 8;
/** A session covers a shift: an interview runs 80 minutes, and they come back to back. */
const SESSION_TTL_SECONDS = 12 * 3600;
/** How many codes one address may ask for per window. */
const CODE_LIMIT = 3;
const CODE_LIMIT_WINDOW = 900;
/** The code burns after this many wrong guesses. */
const MAX_TRIES = 5;

const normalise = (email) => String(email ?? "").trim().toLowerCase();

/**
 * Cloudflare's rate limiter, when one is bound. It counts per location and is permissive
 * by design, so it raises the price of guessing rather than capping it. No binding means
 * `wrangler dev` and the tests.
 */
async function withinLimit(limiter, key) {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

async function sha256(text) {
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
 * DMs a person.
 *
 * The bot token is shared with Hermes and can do more than is needed here, so this
 * worker touches exactly two Slack methods and no others.
 */
async function slackDm(env, email, text) {
  const call = async (method, params) => {
    const r = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
    });
    return r.json();
  };

  const found = await call("users.lookupByEmail", { email });
  if (!found.ok) return false;
  const sent = await call("chat.postMessage", { channel: found.user.id, text });
  return sent.ok === true;
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
  if (!email.includes("@")) return same();

  if (!(await withinLimit(env.SIGNIN_LIMIT, email))) return same();

  const person = await env.KEYS.get(`admin:${email}`);
  if (!person) return same();

  const rateKey = `otprate:${email}`;
  const used = Number((await env.KEYS.get(rateKey)) ?? 0);
  if (used >= CODE_LIMIT) return same();
  await env.KEYS.put(rateKey, String(used + 1), { expirationTtl: CODE_LIMIT_WINDOW });

  const code = digits(CODE_DIGITS);
  // Store a hash: reading the KV store must not be enough to sign in.
  await env.KEYS.put(
    `otp:${email}`,
    JSON.stringify({ hash: await sha256(`${email}:${code}`), tries: 0 }),
    { expirationTtl: CODE_TTL_SECONDS },
  );

  const dm = slackDm(env, email, `voice-lab admin code: *${code}*\nGood for 10 minutes.`);
  if (ctx?.waitUntil) ctx.waitUntil(dm);
  else await dm;
  return same();
}

/** Trades a correct code for a session. The code is single-use. */
export async function verifyCode(req, env, json) {
  const body = await req.json().catch(() => ({}));
  const email = normalise(body.email);
  const code = String(body.code ?? "").trim();

  if (!(await withinLimit(env.VERIFY_LIMIT, email))) {
    return json({ error: "too many attempts" }, 429);
  }

  const raw = await env.KEYS.get(`otp:${email}`);
  if (!raw) return json({ error: "code expired" }, 401);
  const state = JSON.parse(raw);

  if (state.tries >= MAX_TRIES) {
    await env.KEYS.delete(`otp:${email}`);
    return json({ error: "code expired" }, 401);
  }

  if ((await sha256(`${email}:${code}`)) !== state.hash) {
    await env.KEYS.put(`otp:${email}`, JSON.stringify({ ...state, tries: state.tries + 1 }), {
      expirationTtl: CODE_TTL_SECONDS,
    });
    return json({ error: "wrong code" }, 401);
  }

  await env.KEYS.delete(`otp:${email}`);
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
      name: (await env.KEYS.get(name)) || "",
    })),
  );
  return json({ people });
}

export async function addPerson(req, env, json) {
  const body = await req.json().catch(() => ({}));
  const email = normalise(body.email);
  if (!email.includes("@")) return json({ error: "email required" }, 400);
  await env.KEYS.put(`admin:${email}`, String(body.name ?? "").slice(0, 80));
  return json({ email });
}

export async function removePerson(email, env, json) {
  const key = `admin:${normalise(email)}`;
  if ((await env.KEYS.get(key)) === null) return json({ error: "no such person" }, 404);
  await env.KEYS.delete(key);
  return json({ removed: normalise(email) });
}
