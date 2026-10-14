import { describe, expect, it, vi, beforeEach } from "vitest";
import worker, { AddressGuard } from "./index.js";
import { ALERT_THRESHOLD, CODES_PER_DAY, MAX_TRIES } from "./guard.js";

const ORIGIN = "http://localhost:5173";

/** KV double: only what the Worker uses, with TTL recorded rather than honoured. */
function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ttls = new Map();
  const reads = [];
  return {
    store,
    ttls,
    reads,
    get: async (k) => {
      reads.push(k);
      return store.get(k) ?? null;
    },
    put: async (k, v, opts) => {
      store.set(k, v);
      if (opts?.expirationTtl) ttls.set(k, opts.expirationTtl);
    },
    delete: async (k) => void store.delete(k),
    list: async ({ prefix }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    }),
  };
}

/** Two live interview keys, one per engine. */
const LIVE_KEYS = {
  "key:vibe_el": JSON.stringify({ engine: "elevenlabs" }),
  "key:vibe_dg": JSON.stringify({ engine: "deepgram" }),
};

/**
 * Durable Object namespace double running the real AddressGuard, one instance per name,
 * over a synchronous store the way SQLite-backed storage is.
 */
function fakeGuards() {
  const objects = new Map();
  const make = () => {
    const data = new Map();
    const kv = {
      get: (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
      put: (k, v) => void data.set(k, structuredClone(v)),
      delete: (k) => data.delete(k),
    };
    return new AddressGuard({ storage: { kv } });
  };
  return {
    objects,
    idFromName: (name) => name,
    get: (name) => {
      if (!objects.has(name)) objects.set(name, make());
      const object = objects.get(name);
      return { fetch: (url, init) => object.fetch(new Request(url, init)) };
    },
  };
}

/** Rate limiter double: allows `limit` calls per key, records every key it was asked about. */
function fakeLimiter(limit) {
  const counts = new Map();
  return {
    counts,
    limit: async ({ key }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= limit };
    },
  };
}

function env(over = {}) {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    AGENT_ID: "agent_test",
    ELEVENLABS_API_KEY: "el-key",
    ADMIN_TOKEN: "admin-secret",
    KEYS: fakeKv(LIVE_KEYS),
    GUARD: fakeGuards(),
    ...over,
  };
}

const SESSION = "admin-session-token";

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Puts an address on the list and gives it a live session; returns the header for it. */
async function signIn(kv, email = "stas@unimatch.ai") {
  await kv.put(`admin:${email}`, "U0STAS");
  await kv.put(`sess:${await sha256(SESSION)}`, email);
  return { "x-admin-session": SESSION };
}

/** Slack double: records what the bot was asked to send. */
function stubSlack() {
  const sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }));
  });
  return sent;
}

/** Stands in for the Worker's execution context, holding whatever was deferred. */
function fakeCtx() {
  const deferred = [];
  return { waitUntil: (p) => deferred.push(p), settle: () => Promise.all(deferred) };
}

function req(path, { method = "POST", origin = ORIGIN, headers = {}, body, ip = "203.0.113.7" } = {}) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { origin, "cf-connecting-ip": ip, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** ElevenLabs is never really called; the API key must not leave the Worker. */
function stubElevenLabs() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify({ token: "session-token" }), { status: 200 }),
  );
}

beforeEach(() => vi.restoreAllMocks());

describe("minting a session token", () => {
  it("accepts a live key on the ElevenLabs engine", async () => {
    stubElevenLabs();
    const r = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "vibe_el" } }), env());
    expect(r.status).toBe(200);
    expect((await r.json()).token).toBe("session-token");
  });

  it("no longer honours a permanent token from the environment: every key expires", async () => {
    const fetchSpy = stubElevenLabs();
    const e = env({ VIBE_TOKEN: "permanent" });
    const r = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "permanent" } }), e);
    expect(r.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts an interview key that is still in KV", async () => {
    stubElevenLabs();
    const e = env({ KEYS: fakeKv({ "key:vibe_abc": JSON.stringify({ label: "cand" }) }) });
    const r = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "vibe_abc" } }), e);
    expect(r.status).toBe(200);
  });

  it("rejects a key that is not in KV — this is what expiry and revocation rely on", async () => {
    const r = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "vibe_gone" } }), env());
    expect(r.status).toBe(401);
  });

  it("rejects an unknown origin before looking at any token", async () => {
    const r = await worker.fetch(
      req("/agent/token", { origin: "https://evil.test", headers: { "x-vibe-token": "vibe_el" } }),
      env(),
    );
    expect(r.status).toBe(403);
  });

  it("refuses everyone when no KV is bound, since there is nothing to check a key against", async () => {
    const r = await worker.fetch(
      req("/agent/token", { headers: { "x-vibe-token": "vibe_el" } }),
      env({ KEYS: undefined }),
    );
    expect(r.status).toBe(401);
  });
});

/** Deepgram's grant endpoint; records how it was called. */
function stubDeepgram(status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ access_token: "dg-jwt", expires_in: 30 }), { status }),
  );
}

describe("minting a Deepgram grant", () => {
  const dg = (over = {}) => env({ DEEPGRAM_API_KEY: "dg-secret", ...over });

  it("asks Deepgram for a grant with the key and hands back only the grant", async () => {
    const fetchSpy = stubDeepgram();
    const r = await worker.fetch(
      req("/deepgram-token", { headers: { "x-vibe-token": "vibe_dg" } }),
      dg(),
    );

    expect(r.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.deepgram.com/v1/auth/grant");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Token dg-secret");
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ token: "dg-jwt" });
    expect(text, "the API key never leaves the Worker").not.toContain("dg-secret");
  });

  it("accepts a live issued key", async () => {
    stubDeepgram();
    const e = dg({ KEYS: fakeKv({ "key:vibe_abc": JSON.stringify({ engine: "deepgram" }) }) });
    const r = await worker.fetch(req("/deepgram-token", { headers: { "x-vibe-token": "vibe_abc" } }), e);
    expect(r.status).toBe(200);
  });

  it("refuses a caller without a key before spending anything", async () => {
    const fetchSpy = stubDeepgram();
    const r = await worker.fetch(req("/deepgram-token", { headers: { "x-vibe-token": "vibe_gone" } }), dg());
    expect(r.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says Deepgram is not configured rather than calling it without a key", async () => {
    const fetchSpy = stubDeepgram();
    const r = await worker.fetch(
      req("/deepgram-token", { headers: { "x-vibe-token": "vibe_dg" } }),
      env(),
    );
    expect(r.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an upstream refusal as a gateway error", async () => {
    stubDeepgram(403);
    const r = await worker.fetch(
      req("/deepgram-token", { headers: { "x-vibe-token": "vibe_dg" } }),
      dg(),
    );
    expect(r.status).toBe(502);
    expect((await r.json()).status).toBe(403);
  });
});

describe("choosing the engine", () => {
  const engineFor = async (token, e) =>
    worker.fetch(req("/engine", { headers: { "x-vibe-token": token } }), e);

  it("tells the page which engine its key is set to", async () => {
    const e = env({ KEYS: fakeKv({ "key:vibe_dg": JSON.stringify({ engine: "deepgram" }) }) });
    expect(await (await engineFor("vibe_dg", e)).json()).toEqual({ engine: "deepgram" });
  });

  it("defaults to ElevenLabs for keys issued before the switch", async () => {
    const e = env({ KEYS: fakeKv({ "key:vibe_old": JSON.stringify({ label: "x" }) }) });
    expect((await (await engineFor("vibe_old", e)).json()).engine).toBe("elevenlabs");
  });

  it("refuses a stranger", async () => {
    expect((await engineFor("vibe_gone", env())).status).toBe(401);
  });

  it("issues a key on the engine asked for", async () => {
    const e = env();
    const r = await worker.fetch(
      req("/admin/keys", { headers: await signIn(e.KEYS), body: { engine: "deepgram" } }),
      e,
    );
    const issued = await r.json();
    expect(issued.engine).toBe("deepgram");
    expect((await (await engineFor(issued.token, e)).json()).engine).toBe("deepgram");
  });

  it("switches a live key without extending its life", async () => {
    const e = env();
    const headers = await signIn(e.KEYS);
    const expiresAt = Date.now() + 3600_000;
    await e.KEYS.put("key:vibe_k", JSON.stringify({ label: "c", engine: "elevenlabs", issuedAt: 1, expiresAt }));

    const r = await worker.fetch(
      req("/admin/keys/vibe_k", { method: "PATCH", headers, body: { engine: "deepgram" } }),
      e,
    );

    expect(r.status).toBe(200);
    expect((await (await engineFor("vibe_k", e)).json()).engine).toBe("deepgram");
    const stored = JSON.parse(await e.KEYS.get("key:vibe_k"));
    expect(stored.expiresAt).toBe(expiresAt);
    expect(e.KEYS.ttls.get("key:vibe_k")).toBeLessThanOrEqual(3600);
  });

  it("refuses an engine it does not know", async () => {
    const e = env();
    const headers = await signIn(e.KEYS);
    await e.KEYS.put("key:vibe_k", JSON.stringify({ expiresAt: Date.now() + 3600_000 }));
    const r = await worker.fetch(
      req("/admin/keys/vibe_k", { method: "PATCH", headers, body: { engine: "openai" } }),
      e,
    );
    expect(r.status).toBe(400);
  });

  it("will not let a key holder switch its own engine: it takes an admin session", async () => {
    const e = env({ KEYS: fakeKv({ "key:vibe_k": JSON.stringify({ expiresAt: Date.now() + 3600_000 }) }) });
    const r = await worker.fetch(
      req("/admin/keys/vibe_k", {
        method: "PATCH",
        headers: { "x-vibe-token": "vibe_k" },
        body: { engine: "deepgram" },
      }),
      e,
    );
    expect(r.status).toBe(401);
  });

  it("lets the browser send PATCH across origins", async () => {
    const r = await worker.fetch(req("/admin/keys/x", { method: "OPTIONS" }), env());
    expect(r.headers.get("access-control-allow-methods")).toContain("PATCH");
  });
});

describe("issuing interview keys", () => {
  it("issues a prefixed key and stores it under a TTL", async () => {
    const e = env();
    const r = await worker.fetch(
      req("/admin/keys", { headers: await signIn(e.KEYS), body: { hours: 4, label: "Ivan" } }),
      e,
    );
    const issued = await r.json();

    expect(issued.token).toMatch(/^vibe_[0-9a-f]{48}$/);
    expect(issued.label).toBe("Ivan");
    expect(e.KEYS.ttls.get(`key:${issued.token}`)).toBe(4 * 3600);
  });

  it("issues distinct keys, so one candidate's key never unlocks another's", async () => {
    const e = env();
    const headers = await signIn(e.KEYS);
    const call = () =>
      worker.fetch(req("/admin/keys", { headers, body: {} }), e).then((r) => r.json());
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.token).not.toBe(b.token);
  });

  it("promises expiry no earlier than the TTL it actually stored", async () => {
    // KV clamps sub-minute TTLs up to 60s. Reporting the requested lifetime instead made
    // the page show "expired" while the Worker still minted tokens for that key.
    const e = env();
    const r = await worker.fetch(
      req("/admin/keys", { headers: await signIn(e.KEYS), body: { hours: 0.001 } }),
      e,
    );
    const issued = await r.json();
    const storedTtlMs = e.KEYS.ttls.get(`key:${issued.token}`) * 1000;

    expect(issued.expiresAt - issued.issuedAt).toBe(storedTtlMs);
  });

  it("refuses a TTL beyond the cap", async () => {
    const e = env();
    const r = await worker.fetch(
      req("/admin/keys", { headers: await signIn(e.KEYS), body: { hours: 999 } }),
      e,
    );
    expect(r.status).toBe(400);
  });

  it("refuses a candidate key trying to mint itself more keys", async () => {
    const e = env({ KEYS: fakeKv({ "key:vibe_abc": "{}" }) });
    const r = await worker.fetch(
      req("/admin/keys", { headers: { "x-vibe-token": "vibe_abc", "x-admin-token": "vibe_abc" } }),
      e,
    );
    expect(r.status).toBe(401);
  });

  it("refuses the bootstrap password: keys take a named person, not a shared string", async () => {
    const r = await worker.fetch(
      req("/admin/keys", { headers: { "x-admin-token": "admin-secret" } }),
      env(),
    );
    expect(r.status).toBe(401);
  });

  it("refuses admin endpoints when no ADMIN_TOKEN is configured", async () => {
    const r = await worker.fetch(
      req("/admin/people", { method: "GET", headers: { "x-admin-token": "" } }),
      env({ ADMIN_TOKEN: undefined }),
    );
    expect(r.status).toBe(401);
  });
});

describe("listing and revoking", () => {
  it("lists issued keys newest first", async () => {
    const e = env({
      KEYS: fakeKv({
        "key:vibe_old": JSON.stringify({ label: "old", issuedAt: 1 }),
        "key:vibe_new": JSON.stringify({ label: "new", issuedAt: 2 }),
      }),
    });
    const r = await worker.fetch(
      req("/admin/keys", { method: "GET", headers: await signIn(e.KEYS) }),
      e,
    );
    expect((await r.json()).keys.map((k) => k.label)).toEqual(["new", "old"]);
  });

  it("always reports an expiry, so the page cannot render NaN", async () => {
    // A record written by an older version, or by hand, has no expiresAt.
    const e = env({ KEYS: fakeKv({ "key:vibe_partial": JSON.stringify({ label: "old" }) }) });
    const r = await worker.fetch(
      req("/admin/keys", { method: "GET", headers: await signIn(e.KEYS) }),
      e,
    );

    const [key] = (await r.json()).keys.filter((k) => k.token.startsWith("vibe_"));
    expect(Number.isFinite(key.expiresAt)).toBe(true);
    expect(Number.isFinite(key.issuedAt)).toBe(true);
  });

  it("revokes the key the caller named, not its percent-encoded spelling", async () => {
    const e = env({ KEYS: fakeKv({ "key:vibe_a/b": "{}" }) });
    const r = await worker.fetch(
      req("/admin/keys/vibe_a%2Fb", { method: "DELETE", headers: await signIn(e.KEYS) }),
      e,
    );

    expect(r.status).toBe(200);
    expect(e.KEYS.store.has("key:vibe_a/b")).toBe(false);
  });

  it("says so when there was nothing to revoke, instead of reporting success", async () => {
    const e = env();
    const r = await worker.fetch(
      req("/admin/keys/vibe_missing", { method: "DELETE", headers: await signIn(e.KEYS) }),
      e,
    );

    expect(r.status).toBe(404);
  });

  it("revoking removes the key, and the holder immediately loses access", async () => {
    const e = env({ KEYS: fakeKv({ "key:vibe_abc": "{}" }) });
    await worker.fetch(
      req("/admin/keys/vibe_abc", { method: "DELETE", headers: await signIn(e.KEYS) }),
      e,
    );

    const after = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "vibe_abc" } }), e);
    expect(after.status).toBe(401);
  });
});

describe("signing in by code", () => {
  const LISTED = "stas@unimatch.ai";

  async function askFor(email, e, ctx) {
    return worker.fetch(req("/admin/signin", { body: { email } }), e, ctx);
  }

  it("answers an unlisted address exactly as it answers a listed one", async () => {
    stubSlack();
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");

    const ctx = fakeCtx();
    const listed = await askFor(LISTED, e, ctx);
    const stranger = await askFor("someone@example.com", e, ctx);

    expect(stranger.status).toBe(listed.status);
    expect(await stranger.text()).toBe(await listed.text());
    await ctx.settle(); // deferred work outlives the test otherwise, and lands in the next one
  });

  it("touches no storage before replying, so the clock cannot read the list either", async () => {
    // Identical bodies are not enough: a KV hit and a KV miss cost different amounts —
    // 39ms against 102ms, measured — so any lookup before the reply discloses membership.
    stubSlack();
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");
    const ctx = fakeCtx();

    // Reads are given real latency: an instant double resolves in microtasks and cannot
    // show whether the reply waited for one.
    const order = [];
    const read = e.KEYS.get.bind(e.KEYS);
    e.KEYS.get = async (k) => {
      await new Promise((r) => setTimeout(r, 0));
      order.push(`read ${k}`);
      return read(k);
    };

    await askFor(LISTED, e, ctx);
    order.push("replied");

    expect(order[0]).toBe("replied");
    await ctx.settle();
    expect(order).toContain(`read admin:${LISTED}`);
  });

  it("sends the code after the answer, never before it", async () => {
    const sent = stubSlack();
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");
    const ctx = fakeCtx();

    await askFor(LISTED, e, ctx);
    expect(sent).toEqual([]);

    await ctx.settle();
    expect(sent).toHaveLength(1);
  });

  it("sends a code long enough that guessing it is hopeless", async () => {
    const sent = stubSlack();
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");
    const ctx = fakeCtx();

    await askFor(LISTED, e, ctx);
    await ctx.settle();

    expect(sent[0].text).toMatch(/\b\d{8}\b/);
  });

  async function signInFor(email, e) {
    const sent = stubSlack();
    const ctx = fakeCtx();
    await askFor(email, e, ctx);
    await ctx.settle();
    const code = sent[0].text.match(/\d{8}/)[0];
    const r = await worker.fetch(req("/admin/verify", { body: { email, code } }), e);
    return { code, body: await r.json(), status: r.status };
  }

  it("trades a correct code for a session", async () => {
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");

    const { body } = await signInFor(LISTED, e);
    expect(body.session).toMatch(/^[0-9a-f]{48}$/);

    const keys = await worker.fetch(
      req("/admin/keys", { method: "GET", headers: { "x-admin-session": body.session } }),
      e,
    );
    expect(keys.status).toBe(200);
  });

  it("spends the code on first use, so a second try with it fails", async () => {
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");
    const { code } = await signInFor(LISTED, e);

    const again = await worker.fetch(req("/admin/verify", { body: { email: LISTED, code } }), e);
    expect(again.status).toBe(401);
  });

  it("keeps no session token in the clear: the store is not a way in", async () => {
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");
    const { body } = await signInFor(LISTED, e);

    expect(e.KEYS.store.has(`sess:${body.session}`)).toBe(false);
    expect([...e.KEYS.store.values()]).not.toContain(body.session);
  });

  it("burns the code after five wrong guesses", async () => {
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");
    const sent = stubSlack();
    const ctx = fakeCtx();
    await askFor(LISTED, e, ctx);
    await ctx.settle();
    const code = sent[0].text.match(/\d{8}/)[0];

    for (let i = 0; i < 5; i++) {
      await worker.fetch(req("/admin/verify", { body: { email: LISTED, code: "00000000" } }), e);
    }

    const honest = await worker.fetch(req("/admin/verify", { body: { email: LISTED, code } }), e);
    expect(honest.status).toBe(401);
  });

  it("stops guessing when the rate limiter says to", async () => {
    const e = env({ VERIFY_LIMIT: { limit: async () => ({ success: false }) } });
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");

    const r = await worker.fetch(req("/admin/verify", { body: { email: LISTED, code: "1" } }), e);
    expect(r.status).toBe(429);
  });

  it("locks out a live session the moment the person leaves the list", async () => {
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");
    const { body } = await signInFor(LISTED, e);
    const headers = { "x-admin-session": body.session };

    expect((await worker.fetch(req("/admin/keys", { method: "GET", headers }), e)).status).toBe(200);

    await worker.fetch(
      req(`/admin/people/${encodeURIComponent(LISTED)}`, {
        method: "DELETE",
        headers: { "x-admin-token": "admin-secret" },
      }),
      e,
    );

    expect((await worker.fetch(req("/admin/keys", { method: "GET", headers }), e)).status).toBe(401);
  });
});

describe("limits per caller address", () => {
  it("cuts off one address asking for codes across many emails", async () => {
    stubSlack();
    const e = env({ SIGNIN_IP_LIMIT: fakeLimiter(2) });
    const ask = (email, ip) => worker.fetch(req("/admin/signin", { body: { email }, ip }), e);

    expect((await ask("a@x.test", "198.51.100.1")).status).toBe(200);
    expect((await ask("b@x.test", "198.51.100.1")).status).toBe(200);
    expect((await ask("c@x.test", "198.51.100.1")).status).toBe(429);
    expect((await ask("c@x.test", "198.51.100.2")).status).toBe(200);
  });

  it("cuts off one address guessing codes across many emails", async () => {
    const e = env({ VERIFY_IP_LIMIT: fakeLimiter(2) });
    const guess = (email, ip) =>
      worker.fetch(req("/admin/verify", { body: { email, code: "00000000" }, ip }), e);

    expect((await guess("a@x.test", "198.51.100.1")).status).toBe(401);
    expect((await guess("b@x.test", "198.51.100.1")).status).toBe(401);
    expect((await guess("c@x.test", "198.51.100.1")).status).toBe(429);
    expect((await guess("c@x.test", "198.51.100.2")).status).toBe(401);
  });

  it("still limits by email when the guesses come from many addresses", async () => {
    const e = env({ VERIFY_LIMIT: fakeLimiter(1) });
    const guess = (ip) =>
      worker.fetch(req("/admin/verify", { body: { email: "a@x.test", code: "1" }, ip }), e);
    expect((await guess("198.51.100.1")).status).toBe(401);
    expect((await guess("198.51.100.2")).status).toBe(429);
  });
});

describe("limits on spending minutes", () => {
  it("mints at most six tokens a minute for one key", async () => {
    const fetchSpy = stubElevenLabs();
    const limiter = fakeLimiter(6);
    const e = env({ TOKEN_KEY_LIMIT: limiter });
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const r = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "vibe_el" } }), e);
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect([...limiter.counts.keys()].join(), "the limiter never sees the key itself").not.toContain("vibe_el");
  });

  it("gives each key its own budget", async () => {
    stubElevenLabs();
    const e = env({
      TOKEN_KEY_LIMIT: fakeLimiter(1),
      KEYS: fakeKv({ ...LIVE_KEYS, "key:vibe_two": JSON.stringify({ engine: "elevenlabs" }) }),
    });
    const mint = (token) => worker.fetch(req("/agent/token", { headers: { "x-vibe-token": token } }), e);
    expect((await mint("vibe_el")).status).toBe(200);
    expect((await mint("vibe_el")).status).toBe(429);
    expect((await mint("vibe_two")).status).toBe(200);
  });

  it("counts asking for the engine apart from minting, so the page's check does not eat the budget", async () => {
    stubElevenLabs();
    const e = env({ TOKEN_KEY_LIMIT: fakeLimiter(1) });
    const call = (path) => worker.fetch(req(path, { headers: { "x-vibe-token": "vibe_el" } }), e);
    expect((await call("/engine")).status).toBe(200);
    expect((await call("/agent/token")).status).toBe(200);
    expect((await call("/engine")).status).toBe(429);
  });

  it("limits one address before looking at its key, so guessing keys is limited too", async () => {
    const e = env({ TOKEN_IP_LIMIT: fakeLimiter(2) });
    const mint = (token) => worker.fetch(req("/agent/token", { headers: { "x-vibe-token": token } }), e);
    expect((await mint("vibe_guess1")).status).toBe(401);
    expect((await mint("vibe_guess2")).status).toBe(401);
    const reads = e.KEYS.reads.length;
    expect((await mint("vibe_guess3")).status).toBe(429);
    expect(e.KEYS.reads.length).toBe(reads);
  });
});

describe("a key reaches only its own engine", () => {
  it("will not mint a Deepgram grant for an ElevenLabs key", async () => {
    const fetchSpy = stubDeepgram();
    const e = env({ DEEPGRAM_API_KEY: "dg-secret" });
    const r = await worker.fetch(req("/deepgram-token", { headers: { "x-vibe-token": "vibe_el" } }), e);
    expect(r.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 403, not 429, to the wrong engine even when the key's budget is spent", async () => {
    const fetchSpy = stubElevenLabs();
    const limiter = fakeLimiter(1);
    const e = env({ DEEPGRAM_API_KEY: "dg-secret", TOKEN_KEY_LIMIT: limiter });
    const call = (path) => worker.fetch(req(path, { headers: { "x-vibe-token": "vibe_el" } }), e);
    expect((await call("/agent/token")).status).toBe(200);
    expect((await call("/deepgram-token")).status).toBe(403);
    expect((await call("/deepgram-token")).status).toBe(403);
    expect([...limiter.counts.values()], "the refused requests spent nothing").toEqual([1]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("will not mint an ElevenLabs token for a Deepgram key", async () => {
    const fetchSpy = stubElevenLabs();
    const r = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "vibe_dg" } }), env());
    expect(r.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("counting sign-in attempts", () => {
  const LISTED = "stas@unimatch.ai";
  const OTHER_ADMIN = "U0OTHER";

  async function listed() {
    const e = env();
    await e.KEYS.put(`admin:${LISTED}`, "U0STAS");
    await e.KEYS.put("admin:other@unimatch.ai", OTHER_ADMIN);
    return e;
  }

  /** Asks for a code and returns it; `sent` keeps every DM the bot was asked to send. */
  async function requestCode(e, sent) {
    const ctx = fakeCtx();
    const before = sent.length;
    await worker.fetch(req("/admin/signin", { body: { email: LISTED } }), e, ctx);
    await ctx.settle();
    const dm = sent.slice(before).find((m) => /\d{8}/.test(m.text));
    return dm?.text.match(/\d{8}/)[0];
  }

  const verify = (e, code, ctx) =>
    worker.fetch(req("/admin/verify", { body: { email: LISTED, code } }), e, ctx);

  const alerts = (sent) => sent.filter((m) => m.text.includes("wrong sign-in codes"));

  it("counts every one of twenty parallel wrong guesses and burns the code at the cap", async () => {
    const e = await listed();
    const sent = stubSlack();
    const code = await requestCode(e, sent);

    const ctx = fakeCtx();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => verify(e, code === "00000000" ? "00000001" : "00000000", ctx)),
    );
    await ctx.settle();

    expect(results.map((r) => r.status)).toEqual(Array(20).fill(401));
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies.filter((b) => b.error === "wrong code")).toHaveLength(MAX_TRIES - 1);
    expect(e.GUARD.objects.get(LISTED).store.get("failures")).toHaveLength(20);
    expect((await verify(e, code)).status, "the real code is dead after the cap").toBe(401);
  });

  it("accepts a code once even when it arrives twice at the same moment", async () => {
    const e = await listed();
    const sent = stubSlack();
    const code = await requestCode(e, sent);
    const results = await Promise.all([verify(e, code), verify(e, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("logs a warning for every failed guess", async () => {
    const e = await listed();
    const sent = stubSlack();
    await requestCode(e, sent);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await verify(e, "12345678");
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("caps codes per address per day, not only per quarter hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const e = await listed();
      const sent = stubSlack();
      let issued = 0;
      for (let i = 0; i < CODES_PER_DAY + 2; i++) {
        vi.setSystemTime(Date.UTC(2026, 0, 1) + i * 16 * 60_000);
        if (await requestCode(e, sent)) issued++;
      }
      expect(issued).toBe(CODES_PER_DAY);

      vi.setSystemTime(Date.UTC(2026, 0, 2, 12));
      expect(await requestCode(e, sent), "the ceiling lifts after a day").toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sends no more than three codes in a quarter hour", async () => {
    const e = await listed();
    const sent = stubSlack();
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(await requestCode(e, sent));
    expect(codes.filter(Boolean)).toHaveLength(3);
  });

  it("alerts every admin once when wrong codes pile up, and not again inside the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 0, 1));
      const e = await listed();
      const sent = stubSlack();
      await requestCode(e, sent);

      for (let i = 0; i < ALERT_THRESHOLD; i++) await verify(e, "12345678");
      expect(alerts(sent), "at the threshold, not yet").toHaveLength(0);

      for (let i = 0; i < 15; i++) await verify(e, "12345678");
      expect(alerts(sent).map((m) => m.channel).sort()).toEqual([OTHER_ADMIN, "U0STAS"].sort());

      vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 11));
      for (let i = 0; i <= ALERT_THRESHOLD; i++) await verify(e, "12345678");
      expect(alerts(sent), "a new window, a new alert").toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("alerts once when one address asks for codes over and over", async () => {
    const e = await listed();
    const sent = stubSlack();
    for (let i = 0; i < ALERT_THRESHOLD + 5; i++) await requestCode(e, sent);
    const raised = sent.filter((m) => m.text.includes("sign-in code requests"));
    expect(raised).toHaveLength(2); // one DM per admin
  });

  it("does not count guesses against an address that never had a code", async () => {
    const e = env();
    for (let i = 0; i < ALERT_THRESHOLD + 2; i++) {
      await worker.fetch(req("/admin/verify", { body: { email: "nobody@x.test", code: "1" } }), e);
    }
    expect(e.GUARD.objects.get("nobody@x.test").store.get("failures")).toBeUndefined();
  });
});
