/**
 * One Durable Object per admin address, holding its sign-in code and counters. KV cannot
 * count: parallel read-modify-writes see the same tally. Synchronous DO storage never yields
 * mid-step, so each check-and-increment below is atomic.
 */

const MINUTE = 60_000;

/** The code dies ten minutes after it is sent, or after this many wrong guesses. */
export const CODE_TTL_MS = 10 * MINUTE;
export const MAX_TRIES = 5;
/** Codes per address: a short window for a fat finger, a daily ceiling for a script. */
export const CODE_LIMIT = 3;
export const CODE_LIMIT_WINDOW_MS = 15 * MINUTE;
export const CODES_PER_DAY = 10;
const DAY_MS = 24 * 60 * MINUTE;
/** Above this many wrong codes or code requests per window: a person burns a code at five. */
export const ALERT_THRESHOLD = 10;
export const ALERT_WINDOW_MS = 10 * MINUTE;

const recent = (stamps, now, window) => (stamps ?? []).filter((t) => now - t < window);

/** Time between the last alert and now has to cover a whole window before the next one. */
function shouldAlert(store, count, now) {
  if (count <= ALERT_THRESHOLD) return false;
  const last = store.get("alertedAt") ?? 0;
  if (now - last < ALERT_WINDOW_MS) return false;
  store.put("alertedAt", now);
  return true;
}

/** Records a code request; stores the new code's hash only if the address is under its caps. */
export function issue(store, { hash, now }) {
  const requests = [...recent(store.get("requests"), now, ALERT_WINDOW_MS), now];
  store.put("requests", requests);
  const alert = shouldAlert(store, requests.length, now) ? requests.length : 0;

  const issued = recent(store.get("issued"), now, DAY_MS);
  const inWindow = issued.filter((t) => now - t < CODE_LIMIT_WINDOW_MS).length;
  if (inWindow >= CODE_LIMIT || issued.length >= CODES_PER_DAY) {
    return { issued: false, reason: inWindow >= CODE_LIMIT ? "window" : "daily", alert };
  }

  store.put("issued", [...issued, now]);
  store.put("code", { hash, tries: 0, expiresAt: now + CODE_TTL_MS });
  return { issued: true, alert };
}

/**
 * Spends one try on the live code. The try is taken before the hash is compared, so a
 * burst of parallel guesses cannot all slip under the cap.
 */
export function verify(store, { hash, now }) {
  const code = store.get("code");
  if (!code || code.expiresAt <= now) {
    if (code) store.delete("code");
    // An address that never had a code here is not ours to count; it would only create rows.
    if (store.get("issued") === undefined) return { ok: false, reason: "expired", alert: 0 };
    return failure(store, now, "expired");
  }

  if (code.hash === hash) {
    store.delete("code");
    return { ok: true, alert: 0 };
  }

  const tries = code.tries + 1;
  if (tries >= MAX_TRIES) store.delete("code");
  else store.put("code", { ...code, tries });
  return failure(store, now, tries >= MAX_TRIES ? "burned" : "wrong");
}

function failure(store, now, reason) {
  const failures = [...recent(store.get("failures"), now, ALERT_WINDOW_MS), now];
  store.put("failures", failures);
  return { ok: false, reason, alert: shouldAlert(store, failures.length, now) ? failures.length : 0 };
}

const OPS = { issue, verify };

/**
 * Plain class with a fetch handler rather than an RPC subclass: `DurableObject` comes from
 * `cloudflare:workers`, which the test runner cannot import.
 */
export class AddressGuard {
  constructor(state) {
    this.store = state.storage.kv;
  }

  async fetch(req) {
    const { op, ...args } = await req.json();
    const run = OPS[op];
    if (!run) return Response.json({ error: "unknown op" }, { status: 400 });
    return Response.json(run(this.store, { ...args, now: Date.now() }));
  }
}

/** Calls the guard of one address. */
export async function guard(env, email, op, args = {}) {
  const stub = env.GUARD.get(env.GUARD.idFromName(email));
  const r = await stub.fetch("https://guard/", {
    method: "POST",
    body: JSON.stringify({ op, ...args }),
  });
  return r.json();
}
