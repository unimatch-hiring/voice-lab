import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import { DEFAULT_MAX_TOKENS, LlmBudget, MAX_BODY_BYTES, MAX_BUDGET_USD } from "./llm.js";

const ORIGIN = "http://localhost:5173";
const OPENROUTER_KEY = "sk-or-v1-test-secret-not-real";
const KEY = "vibe_candidate";
const IN_AN_HOUR = Date.now() + 3600_000;

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    list: async ({ prefix }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    }),
  };
}

/** Durable Object namespace running the real LlmBudget, one per name, over synchronous storage. */
function fakeBudgets() {
  const objects = new Map();
  const make = () => {
    const data = new Map();
    const storage = {
      kv: {
        get: (k) => data.get(k),
        put: (k, v) => void data.set(k, v),
      },
      alarm: null,
      setAlarm: async (t) => void (storage.alarm = t),
      deleteAll: async () => data.clear(),
    };
    const object = new LlmBudget({ storage });
    object.data = data;
    object.storageDouble = storage;
    return object;
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

const record = (over = {}) => JSON.stringify({ label: "cand", engine: "elevenlabs", expiresAt: IN_AN_HOUR, ...over });

function env(over = {}) {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    KEYS: fakeKv({ [`key:${KEY}`]: record() }),
    LLM_BUDGET: fakeBudgets(),
    ...over,
  };
}

/** A server-side call, the way the candidate's backend or curl sends it: no Origin. */
function llm(body, { token = KEY, path = "/llm/v1/chat/completions", method = "POST", headers = {} } = {}) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      "cf-connecting-ip": "203.0.113.7",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ask = (over = {}) => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Is this phrase alarming?" }],
  ...over,
});

/** OpenRouter double: answers every call with the given body, records what it was sent. */
function stubOpenRouter({ cost = 0.001, status = 200, body, delayMs = 0 } = {}) {
  const calls = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const answer = body ?? {
      id: "gen-1",
      choices: [{ message: { role: "assistant", content: "safe" } }],
      usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21, cost },
    };
    return new Response(JSON.stringify(answer), { status });
  });
  return { calls, spy };
}

const spentOf = async (e, token = KEY) => {
  const id = await sha256(token);
  return e.LLM_BUDGET.objects.get(id)?.data.get("spentMicros") ?? 0;
};

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

beforeEach(() => vi.restoreAllMocks());

describe("who may use the LLM proxy", () => {
  it("answers a live interview key with the model's reply", async () => {
    stubOpenRouter();
    const r = await worker.fetch(llm(ask()), env());
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toBe("safe");
  });

  it("sends OpenRouter our key, never the candidate's", async () => {
    const { calls } = stubOpenRouter();
    await worker.fetch(llm(ask()), env());
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
  });

  it("takes the key in x-vibe-token too, like the rest of the Worker", async () => {
    stubOpenRouter();
    const r = await worker.fetch(llm(ask(), { token: null, headers: { "x-vibe-token": KEY } }), env());
    expect(r.status).toBe(200);
  });

  it("rejects a key that is not in KV without calling OpenRouter", async () => {
    const { spy } = stubOpenRouter();
    const r = await worker.fetch(llm(ask(), { token: "vibe_revoked" }), env());
    expect(r.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a key past its expiry that KV has not dropped yet", async () => {
    const { spy } = stubOpenRouter();
    const e = env({ KEYS: fakeKv({ [`key:${KEY}`]: record({ expiresAt: Date.now() - 1000 }) }) });
    const r = await worker.fetch(llm(ask()), e);
    expect(r.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a call with no key at all", async () => {
    const { spy } = stubOpenRouter();
    const r = await worker.fetch(llm(ask(), { token: null }), env());
    expect(r.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("lets a candidate's dev server send the Bearer header through CORS", async () => {
    const preflight = new Request("https://worker.test/llm/v1/chat/completions", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    });
    const r = await worker.fetch(preflight, env());
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("says plainly when the proxy has no OpenRouter key yet", async () => {
    const r = await worker.fetch(llm(ask()), env({ OPENROUTER_API_KEY: undefined }));
    expect(r.status).toBe(503);
  });

  it("lists the allowed models to an OpenAI client", async () => {
    const r = await worker.fetch(llm(undefined, { path: "/llm/v1/models", method: "GET" }), env());
    const ids = (await r.json()).data.map((m) => m.id);
    expect(ids).toContain("openai/gpt-4o-mini");
  });
});

describe("what a call may ask for", () => {
  it("refuses a model outside the list before it reaches OpenRouter", async () => {
    const { spy } = stubOpenRouter();
    const r = await worker.fetch(llm(ask({ model: "openai/o1-pro" })), env());
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/model must be one of/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("follows LLM_MODELS when it is set", async () => {
    stubOpenRouter();
    const e = env({ LLM_MODELS: "acme/tiny" });
    expect((await worker.fetch(llm(ask({ model: "acme/tiny" })), e)).status).toBe(200);
    expect((await worker.fetch(llm(ask()), e)).status).toBe(400);
  });

  it("refuses max_tokens above the cap", async () => {
    const { spy } = stubOpenRouter();
    const r = await worker.fetch(llm(ask({ max_tokens: DEFAULT_MAX_TOKENS + 1 })), env());
    expect(r.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("caps a call that names no max_tokens", async () => {
    const { calls } = stubOpenRouter();
    await worker.fetch(llm(ask()), env());
    expect(calls[0].body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("refuses streaming rather than leave it unmetered", async () => {
    const { spy } = stubOpenRouter();
    const r = await worker.fetch(llm(ask({ stream: true })), env());
    expect(r.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["an image", { type: "image_url", image_url: { url: "https://example.test/a.png", detail: "high" } }],
    ["audio", { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }],
    ["a file", { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AAAA" } }],
  ])("refuses %s in a message, which its byte count does not price", async (_, part) => {
    const { spy } = stubOpenRouter();
    const content = [{ type: "text", text: "look" }, part];
    const r = await worker.fetch(llm(ask({ messages: [{ role: "user", content }] })), env());
    expect(r.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes text parts through", async () => {
    const { calls } = stubOpenRouter();
    const content = [{ type: "text", text: "Is this alarming?" }];
    await worker.fetch(llm(ask({ messages: [{ role: "user", content }] })), env());
    expect(calls[0].body.messages[0].content).toEqual(content);
  });

  it("refuses tools other than functions", async () => {
    const { spy } = stubOpenRouter();
    const r = await worker.fetch(llm(ask({ tools: [{ type: "web_search" }] })), env());
    expect(r.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a body over the size cap", async () => {
    const { spy } = stubOpenRouter();
    const huge = "x".repeat(MAX_BODY_BYTES);
    const r = await worker.fetch(llm(ask({ messages: [{ role: "user", content: huge }] })), env());
    expect(r.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops fields that would route around the list or bill extra", async () => {
    const { calls } = stubOpenRouter();
    await worker.fetch(
      llm(ask({ models: ["openai/o1-pro"], plugins: [{ id: "web" }], provider: { sort: "price" } })),
      env(),
    );
    expect(calls[0].body.models).toBeUndefined();
    expect(calls[0].body.plugins).toBeUndefined();
    expect(calls[0].body.provider).toBeUndefined();
  });
});

describe("the budget per key", () => {
  it("adds up the cost OpenRouter reports", async () => {
    stubOpenRouter({ cost: 0.25 });
    const e = env();
    await worker.fetch(llm(ask()), e);
    await worker.fetch(llm(ask()), e);
    expect(await spentOf(e)).toBe(500_000);
  });

  it("refuses with 402 once the key has spent its $5, without calling OpenRouter", async () => {
    const { spy } = stubOpenRouter({ cost: 2.5 });
    const e = env();
    await worker.fetch(llm(ask()), e);
    await worker.fetch(llm(ask()), e);
    spy.mockClear();

    const r = await worker.fetch(llm(ask()), e);
    expect(r.status).toBe(402);
    expect((await r.json()).error.message).toMatch(/\$5\.00 of \$5\.00/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("honours a smaller budget set when the key was issued", async () => {
    stubOpenRouter({ cost: 0.05 });
    const e = env({ KEYS: fakeKv({ [`key:${KEY}`]: record({ budgetUsd: 0.05 }) }) });
    expect((await worker.fetch(llm(ask()), e)).status).toBe(200);
    expect((await worker.fetch(llm(ask()), e)).status).toBe(402);
  });

  it("keeps one key's spending off another's", async () => {
    stubOpenRouter({ cost: 5 });
    const e = env({ KEYS: fakeKv({ [`key:${KEY}`]: record(), "key:vibe_other": record() }) });
    await worker.fetch(llm(ask()), e);
    expect((await worker.fetch(llm(ask(), { token: "vibe_other" }), e)).status).toBe(200);
  });

  it("loses no charge when calls run in parallel", async () => {
    stubOpenRouter({ cost: 0.1 });
    const e = env();
    await Promise.all(Array.from({ length: 10 }, () => worker.fetch(llm(ask()), e)));
    expect(await spentOf(e)).toBe(1_000_000);
  });

  it("does not let slow parallel calls overspend the budget together", async () => {
    // ~40 kB of prompt reserves ~$0.41 a call; each is billed $0.30, under its reservation.
    stubOpenRouter({ cost: 0.3, delayMs: 50 });
    const e = env();
    const prompt = ask({ messages: [{ role: "user", content: "a".repeat(40_000) }] });
    const answers = await Promise.all(Array.from({ length: 30 }, () => worker.fetch(llm(prompt), e)));
    const statuses = answers.map((r) => r.status);

    expect(statuses).toContain(402);
    expect(await spentOf(e)).toBeLessThanOrEqual(MAX_BUDGET_USD * 1_000_000);
  });

  it("takes the reservation before the call, so hanging up does not dodge the charge", async () => {
    let release;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const e = env();
    const pending = worker.fetch(llm(ask()), e);
    await vi.waitFor(() => expect(release).toBeDefined());

    expect(await spentOf(e)).toBeGreaterThan(0);
    release(new Response(JSON.stringify({ choices: [], usage: { cost: 0 } })));
    await pending;
  });

  it("gives the reservation back when OpenRouter answers with an error", async () => {
    stubOpenRouter({ status: 400, body: { error: { message: "context too long" } } });
    const e = env();
    await worker.fetch(llm(ask()), e);
    expect(await spentOf(e)).toBe(0);
  });

  it("still charges a call whose answer carries no cost", async () => {
    stubOpenRouter({ body: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } } });
    const e = env();
    await worker.fetch(llm(ask()), e);
    expect(await spentOf(e)).toBeGreaterThan(0);
  });

  it("forgets the tally when the key expires", async () => {
    stubOpenRouter({ cost: 1 });
    const e = env();
    await worker.fetch(llm(ask()), e);
    const meter = e.LLM_BUDGET.objects.get(await sha256(KEY));
    expect(meter.storageDouble.alarm).toBe(IN_AN_HOUR);

    await meter.alarm();
    expect(await spentOf(e)).toBe(0);
  });
});

describe("the OpenRouter key never reaches the candidate", () => {
  it("is scrubbed from an upstream error that echoes it", async () => {
    stubOpenRouter({ status: 400, body: { error: { message: `bad request for ${OPENROUTER_KEY}` } } });
    const r = await worker.fetch(llm(ask()), env());
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(text).not.toContain(OPENROUTER_KEY);
  });

  it("is scrubbed from a successful answer that echoes it", async () => {
    stubOpenRouter({ body: { choices: [{ message: { content: OPENROUTER_KEY } }], usage: { cost: 0 } } });
    const text = await (await worker.fetch(llm(ask()), env())).text();
    expect(text).not.toContain(OPENROUTER_KEY);
  });

  it("turns OpenRouter refusing our key into a 502, not a 401 the candidate would blame on theirs", async () => {
    stubOpenRouter({ status: 401, body: { error: { message: "No auth credentials found" } } });
    const r = await worker.fetch(llm(ask()), env());
    expect(r.status).toBe(502);
  });

  it("stays out of the refusal logs", async () => {
    stubOpenRouter();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.fetch(llm(ask({ model: "nope/nope" })), env());
    await worker.fetch(llm(ask(), { token: "vibe_wrong" }), env());
    const written = log.mock.calls.flat().join("\n");
    expect(written).not.toContain(OPENROUTER_KEY);
    expect(written).not.toContain("vibe_wrong");
  });
});

describe("spending in the admin list", () => {
  const SESSION = "admin-session-token";

  async function adminEnv(e) {
    await e.KEYS.put("admin:interviewer@example.com", "U0TEST");
    await e.KEYS.put(`sess2:${await sha256(SESSION)}`, "interviewer@example.com");
    return e;
  }

  const admin = (path, { method = "GET", body } = {}) =>
    new Request(`https://worker.test${path}`, {
      method,
      headers: { origin: ORIGIN, "x-admin-session": SESSION, "cf-connecting-ip": "203.0.113.7" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("shows what each key has spent and its budget", async () => {
    stubOpenRouter({ cost: 0.42 });
    const e = await adminEnv(env());
    await worker.fetch(llm(ask()), e);

    const { keys } = await (await worker.fetch(admin("/admin/keys"), e)).json();
    expect(keys[0]).toMatchObject({ spentUsd: 0.42, budgetUsd: MAX_BUDGET_USD });
  });

  /** The per-admin minting cap is guard.js's business and tested there; here it always allows. */
  const openGuard = {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => Response.json({ ok: true }) }),
  };

  it("issues a key with $5 unless told otherwise, and with less when asked", async () => {
    const e = await adminEnv(env({ GUARD: openGuard }));
    const plain = await (await worker.fetch(admin("/admin/keys", { method: "POST", body: {} }), e)).json();
    const small = await (
      await worker.fetch(admin("/admin/keys", { method: "POST", body: { budgetUsd: 1 } }), e)
    ).json();
    expect([plain.budgetUsd, small.budgetUsd]).toEqual([5, 1]);
    expect(JSON.parse(e.KEYS.store.get(`key:${small.token}`)).budgetUsd).toBe(1);
  });

  it("still lists the keys when one meter cannot be read", async () => {
    const e = await adminEnv(env({ LLM_BUDGET: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("down"); } }) } }));
    const r = await worker.fetch(admin("/admin/keys"), e);
    expect(r.status).toBe(200);
    expect((await r.json()).keys[0].spentUsd).toBeUndefined();
  });

  it("refuses to issue a key with a budget above the ceiling", async () => {
    const e = await adminEnv(env({ GUARD: openGuard }));
    const r = await worker.fetch(admin("/admin/keys", { method: "POST", body: { budgetUsd: 50 } }), e);
    expect(r.status).toBe(400);
  });
});
