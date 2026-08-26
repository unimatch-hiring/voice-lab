import { describe, expect, it, vi, beforeEach } from "vitest";
import worker from "./index.js";

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

function env(over = {}) {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    AGENT_ID: "agent_test",
    ELEVENLABS_API_KEY: "el-key",
    VIBE_TOKEN: "permanent",
    ADMIN_TOKEN: "admin-secret",
    KEYS: fakeKv(),
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

function req(path, { method = "POST", origin = ORIGIN, headers = {}, body } = {}) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** ElevenLabs is never really called; the API key must not leave the Worker. */
function stubElevenLabs() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ token: "session-token" }), { status: 200 }),
  );
}

beforeEach(() => vi.restoreAllMocks());

describe("minting a session token", () => {
  it("accepts the permanent token", async () => {
    stubElevenLabs();
    const r = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "permanent" } }), env());
    expect(r.status).toBe(200);
    expect((await r.json()).token).toBe("session-token");
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
      req("/agent/token", { origin: "https://evil.test", headers: { "x-vibe-token": "permanent" } }),
      env(),
    );
    expect(r.status).toBe(403);
  });

  it("still works with no KV bound, so a plain deployment is unaffected", async () => {
    stubElevenLabs();
    const r = await worker.fetch(
      req("/agent/token", { headers: { "x-vibe-token": "permanent" } }),
      env({ KEYS: undefined }),
    );
    expect(r.status).toBe(200);
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

describe("minting a signed url for the side layers", () => {
  it("returns the url and never the api key", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ signed_url: "wss://api.elevenlabs.io/x?token=abc" }), {
        status: 200,
      }),
    );

    const r = await worker.fetch(
      req("/agent/signed-url", { headers: { "x-vibe-token": "permanent" } }),
      env(),
    );

    expect(r.status).toBe(200);
    expect((await r.json()).signedUrl).toBe("wss://api.elevenlabs.io/x?token=abc");
    expect(JSON.stringify(spy.mock.calls[0])).toContain("get-signed-url");
  });

  it("refuses a caller without a token", async () => {
    const r = await worker.fetch(req("/agent/signed-url"), env());
    expect(r.status).toBe(401);
  });

  it("reports an upstream failure rather than passing it off as a url", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const r = await worker.fetch(
      req("/agent/signed-url", { headers: { "x-vibe-token": "permanent" } }),
      env(),
    );
    expect(r.status).toBe(502);
  });
});
