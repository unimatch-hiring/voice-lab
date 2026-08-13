import { describe, expect, it, vi, beforeEach } from "vitest";
import worker from "./index.js";

const ORIGIN = "http://localhost:5173";

/** KV double: only what the Worker uses, with TTL recorded rather than honoured. */
function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ttls = new Map();
  return {
    store,
    ttls,
    get: async (k) => store.get(k) ?? null,
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
      req("/admin/keys", { headers: { "x-admin-token": "admin-secret" }, body: { hours: 4, label: "Ivan" } }),
      e,
    );
    const issued = await r.json();

    expect(issued.token).toMatch(/^vibe_[0-9a-f]{48}$/);
    expect(issued.label).toBe("Ivan");
    expect(e.KEYS.ttls.get(`key:${issued.token}`)).toBe(4 * 3600);
  });

  it("issues distinct keys, so one candidate's key never unlocks another's", async () => {
    const e = env();
    const call = () =>
      worker
        .fetch(req("/admin/keys", { headers: { "x-admin-token": "admin-secret" }, body: {} }), e)
        .then((r) => r.json());
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.token).not.toBe(b.token);
  });

  it("promises expiry no earlier than the TTL it actually stored", async () => {
    // KV clamps sub-minute TTLs up to 60s. Reporting the requested lifetime instead made
    // the page show "expired" while the Worker still minted tokens for that key.
    const e = env();
    const r = await worker.fetch(
      req("/admin/keys", { headers: { "x-admin-token": "admin-secret" }, body: { hours: 0.001 } }),
      e,
    );
    const issued = await r.json();
    const storedTtlMs = e.KEYS.ttls.get(`key:${issued.token}`) * 1000;

    expect(issued.expiresAt - issued.issuedAt).toBe(storedTtlMs);
  });

  it("refuses a TTL beyond the cap", async () => {
    const r = await worker.fetch(
      req("/admin/keys", { headers: { "x-admin-token": "admin-secret" }, body: { hours: 999 } }),
      env(),
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

  it("refuses admin endpoints when no ADMIN_TOKEN is configured", async () => {
    const r = await worker.fetch(
      req("/admin/keys", { headers: { "x-admin-token": "" } }),
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
      req("/admin/keys", { method: "GET", headers: { "x-admin-token": "admin-secret" } }),
      e,
    );
    expect((await r.json()).keys.map((k) => k.label)).toEqual(["new", "old"]);
  });

  it("always reports an expiry, so the page cannot render NaN", async () => {
    // A record written by an older version, or by hand, has no expiresAt.
    const e = env({ KEYS: fakeKv({ "key:vibe_partial": JSON.stringify({ label: "old" }) }) });
    const r = await worker.fetch(
      req("/admin/keys", { method: "GET", headers: { "x-admin-token": "admin-secret" } }),
      e,
    );

    const [key] = (await r.json()).keys;
    expect(Number.isFinite(key.expiresAt)).toBe(true);
    expect(Number.isFinite(key.issuedAt)).toBe(true);
  });

  it("revokes the key the caller named, not its percent-encoded spelling", async () => {
    const e = env({ KEYS: fakeKv({ "key:vibe_a/b": "{}" }) });
    const r = await worker.fetch(
      req("/admin/keys/vibe_a%2Fb", { method: "DELETE", headers: { "x-admin-token": "admin-secret" } }),
      e,
    );

    expect(r.status).toBe(200);
    expect(e.KEYS.store.has("key:vibe_a/b")).toBe(false);
  });

  it("says so when there was nothing to revoke, instead of reporting success", async () => {
    const r = await worker.fetch(
      req("/admin/keys/vibe_missing", { method: "DELETE", headers: { "x-admin-token": "admin-secret" } }),
      env(),
    );

    expect(r.status).toBe(404);
  });

  it("revoking removes the key, and the holder immediately loses access", async () => {
    const e = env({ KEYS: fakeKv({ "key:vibe_abc": "{}" }) });
    await worker.fetch(
      req("/admin/keys/vibe_abc", { method: "DELETE", headers: { "x-admin-token": "admin-secret" } }),
      e,
    );

    const after = await worker.fetch(req("/agent/token", { headers: { "x-vibe-token": "vibe_abc" } }), e);
    expect(after.status).toBe(401);
  });
});
