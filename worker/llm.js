/**
 * OpenAI-compatible proxy to OpenRouter for the candidate's own server. The candidate holds
 * only their interview key; OPENROUTER_API_KEY stays a Worker secret. Every key has a dollar
 * budget, counted from the cost OpenRouter reports for each call.
 */

import { clientIp, sha256, withinLimit } from "./signin.js";

export const LLM_PATHS = ["/llm/v1/chat/completions", "/llm/v1/models"];

/** The ceiling, not just the default: one interview is a few hundred classifier calls. */
export const MAX_BUDGET_USD = 5;
export const DEFAULT_BUDGET_USD = MAX_BUDGET_USD;

/** Cheap text models, enough for a phrase classifier. `LLM_MODELS` in wrangler.toml overrides. */
export const DEFAULT_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-nano",
  "openai/gpt-5-nano",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-flash",
  "meta-llama/llama-3.3-70b-instruct",
  "mistralai/mistral-small-3.2-24b-instruct",
  "qwen/qwen3-30b-a3b-instruct-2507",
];
export const DEFAULT_MAX_TOKENS = 1024;
const MAX_BODY_CHARS = 200_000;

/**
 * Charged when OpenRouter's answer carries no cost: above the dearest listed model, so a
 * missing field can only make a key run out sooner, never let it overspend.
 */
const FALLBACK_USD_PER_TOKEN = 10 / 1_000_000;

/**
 * Only these request fields reach OpenRouter. Anything else is dropped, notably `models`
 * (fallback routing would bypass the model list), `plugins` and `web_search_options`
 * (billed on top of tokens) and `stream`.
 */
const FORWARDED = [
  "model", "messages", "max_tokens", "temperature", "top_p", "top_k", "stop", "seed",
  "response_format", "tools", "tool_choice", "presence_penalty", "frequency_penalty",
  "repetition_penalty", "logprobs", "top_logprobs",
];

const MICROS = 1_000_000;
const toMicros = (usd) => Math.max(0, Math.round(usd * MICROS));
const toUsd = (micros) => micros / MICROS;

const listOf = (value) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const allowedModels = (env) => {
  const configured = listOf(env.LLM_MODELS);
  return configured.length ? configured : DEFAULT_MODELS;
};

const maxTokens = (env) => Number(env.LLM_MAX_TOKENS) || DEFAULT_MAX_TOKENS;

/** Records issued before budgets existed get the default. */
export const budgetUsdOf = (record) =>
  typeof record?.budgetUsd === "number" ? record.budgetUsd : DEFAULT_BUDGET_USD;

/** `undefined` means "use the default"; anything outside (0, MAX] is refused at issue time. */
export function parseBudget(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_BUDGET_USD;
  const usd = Number(value);
  return usd > 0 && usd <= MAX_BUDGET_USD ? usd : null;
}

/**
 * One Durable Object per key, named by the key's hash. KV cannot count — parallel
 * read-modify-writes lose updates, and it allows one write per second per key — while a
 * candidate's server easily fires several calls at once. Storage writes here are synchronous,
 * so each charge is atomic. The alarm drops the tally when the key itself expires.
 */
export class LlmBudget {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(req) {
    const { op, micros = 0, expiresAt } = await req.json();
    const kv = this.storage.kv;
    const spent = kv.get("spentMicros") ?? 0;
    if (op === "read") return Response.json({ spentMicros: spent });
    if (op !== "charge") return Response.json({ error: "unknown op" }, { status: 400 });

    const next = spent + Math.max(0, Math.round(micros));
    kv.put("spentMicros", next);
    if (expiresAt) await this.storage.setAlarm(expiresAt);
    return Response.json({ spentMicros: next });
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}

async function meter(env, tokenHash, op, args = {}) {
  const stub = env.LLM_BUDGET.get(env.LLM_BUDGET.idFromName(tokenHash));
  const r = await stub.fetch("https://budget/", {
    method: "POST",
    body: JSON.stringify({ op, ...args }),
  });
  return (await r.json()).spentMicros;
}

/** What the key has spent so far, in dollars; 0 where no meter is bound. */
export async function spentUsd(env, tokenHash) {
  if (!env.LLM_BUDGET) return 0;
  return toUsd(await meter(env, tokenHash, "read"));
}

/** Bearer, as every OpenAI client sends it; x-vibe-token, as the rest of this Worker takes it. */
function presentedToken(req) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(\S+)$/i);
  return bearer ? bearer[1] : req.headers.get("x-vibe-token") ?? "";
}

/** Error body in OpenAI's shape, so a client SDK shows the message instead of "unknown error". */
const failure = (message, type) => ({ error: { message, type } });

/** Never trust an upstream text not to echo what we sent it. */
const redact = (text, secret) => (secret ? text.split(secret).join("[redacted]") : text);

function costOf(usage) {
  if (typeof usage?.cost === "number") return { usd: usage.cost, estimated: false };
  const tokens = Number(usage?.total_tokens) ||
    (Number(usage?.prompt_tokens) || 0) + (Number(usage?.completion_tokens) || 0);
  // No usage at all still cost something; charge as if the whole completion budget was used.
  return { usd: (tokens || DEFAULT_MAX_TOKENS) * FALLBACK_USD_PER_TOKEN, estimated: true };
}

/** Builds the body OpenRouter gets, or returns the reason the request is refused. */
function upstreamBody(body, env) {
  if (body?.stream) return { error: "stream is not supported by this proxy; send stream: false" };
  if (!allowedModels(env).includes(body?.model)) {
    return { error: `model must be one of: ${allowedModels(env).join(", ")}` };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: "messages must be a non-empty array" };
  }
  if (body.n !== undefined && body.n !== 1) return { error: "n must be 1" };

  const cap = maxTokens(env);
  const asked = body.max_tokens ?? body.max_completion_tokens;
  if (asked !== undefined && !(Number.isInteger(asked) && asked > 0 && asked <= cap)) {
    return { error: `max_tokens must be an integer between 1 and ${cap}` };
  }

  const forwarded = Object.fromEntries(FORWARDED.filter((k) => k in body).map((k) => [k, body[k]]));
  return {
    body: { ...forwarded, max_tokens: asked ?? cap, stream: false, usage: { include: true } },
  };
}

/**
 * Handles everything under /llm/v1/. `json` carries the CORS headers; `refuse` also logs
 * the refusal, without the key.
 */
export async function handleLlm(req, env, { path, json, refuse }) {
  const refused = (reason, status, message, type = "invalid_request_error") => {
    refuse(reason);
    return json(failure(message, type), status);
  };

  if (!(await withinLimit(env.LLM_LIMIT, `ip:${clientIp(req)}`))) {
    return refused("llm_ip_rate_limited", 429, "too many requests", "rate_limit_error");
  }
  const token = presentedToken(req);
  const raw = token && env.KEYS ? await env.KEYS.get(`key:${token}`) : null;
  if (raw === null) return refused("llm_key_invalid", 401, "invalid interview key", "authentication_error");
  const record = JSON.parse(raw);
  const tokenHash = await sha256(token);
  if (!(await withinLimit(env.LLM_LIMIT, `key:${tokenHash}`))) {
    return refused("llm_key_rate_limited", 429, "too many requests", "rate_limit_error");
  }

  if (path === "/llm/v1/models") {
    if (req.method !== "GET") return json(failure("method not allowed", "invalid_request_error"), 405);
    return json({ object: "list", data: allowedModels(env).map((id) => ({ id, object: "model" })) });
  }
  if (req.method !== "POST") return json(failure("method not allowed", "invalid_request_error"), 405);

  if (!env.OPENROUTER_API_KEY || !env.LLM_BUDGET) {
    return json(failure("llm proxy is not configured", "server_error"), 503);
  }

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return refused("llm_body_too_large", 413, "request body too large");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused("llm_bad_json", 400, "body must be JSON");
  }
  const built = upstreamBody(parsed, env);
  if (built.error) return refused("llm_bad_request", 400, built.error);

  // Checked before the call, charged after it: a call in flight can take a key a few cents
  // past its budget, never further, since max_tokens bounds what one call costs.
  const budget = budgetUsdOf(record);
  const spent = toUsd(await meter(env, tokenHash, "read"));
  if (spent >= budget) {
    return refused(
      "llm_budget_exhausted",
      402,
      `this key has used its LLM budget: $${spent.toFixed(2)} of $${budget.toFixed(2)}`,
      "insufficient_quota",
    );
  }

  let upstream;
  try {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "x-title": "voice-lab interview",
      },
      body: JSON.stringify(built.body),
    });
  } catch {
    return json(failure("llm provider unreachable", "server_error"), 502);
  }

  const answer = redact(await upstream.text(), env.OPENROUTER_API_KEY);
  let payload = null;
  try {
    payload = JSON.parse(answer);
  } catch {
    // Not JSON: nothing to charge and nothing worth relaying.
  }

  if (!upstream.ok) {
    const message = typeof payload?.error?.message === "string" ? payload.error.message.slice(0, 500) : "";
    // OpenRouter's own 401/402/403 is about our account, not the candidate's key; passing it
    // through would read as "your key is bad" or "your budget is gone".
    if ([401, 402, 403].includes(upstream.status)) {
      console.log(JSON.stringify({ reason: "llm_upstream_refused", status: upstream.status, path }));
      return json(failure("llm provider refused the proxy; tell the interviewer", "server_error"), 502);
    }
    return json(failure(message || `llm provider error ${upstream.status}`, "upstream_error"), upstream.status);
  }
  if (!payload) return json(failure("llm provider sent an unreadable answer", "server_error"), 502);

  const cost = costOf(payload.usage);
  if (cost.estimated) console.log(JSON.stringify({ reason: "llm_cost_missing", path, model: built.body.model }));
  await meter(env, tokenHash, "charge", { micros: toMicros(cost.usd), expiresAt: record.expiresAt });

  return json(payload);
}
