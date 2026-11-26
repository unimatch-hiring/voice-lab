/**
 * OpenAI-compatible proxy to OpenRouter for the candidate's own server. The candidate holds
 * only their interview key; OPENROUTER_API_KEY stays a Worker secret. Every key has a dollar
 * budget: each call reserves its worst case up front and gets back what OpenRouter did not bill.
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
  "google/gemini-2.5-flash-lite",
  "meta-llama/llama-3.3-70b-instruct",
  "mistralai/mistral-small-3.2-24b-instruct",
  "qwen/qwen3-30b-a3b-instruct-2507",
];
export const DEFAULT_MAX_TOKENS = 1024;
/** A classifier call is a couple of kilobytes; this keeps one call's reservation under $0.70. */
export const MAX_BODY_BYTES = 64_000;

/**
 * The price a reservation assumes for every token, in and out. It must stay above the dearest
 * model in LLM_MODELS (gpt-4.1-mini, $1.60/M out), or a reservation could be smaller than the bill.
 */
export const CEILING_USD_PER_TOKEN = 10 / 1_000_000;
/** Chat-template tokens a provider adds around each message. */
const PER_MESSAGE_TOKENS = 16;

/**
 * Only these request fields reach OpenRouter. Anything else is dropped, notably `models`
 * (fallback routing would bypass the model list), `plugins` and `web_search_options`
 * (billed on top of tokens) and `stream`. `messages` is rebuilt, see `textMessage`.
 */
const FORWARDED = [
  "model", "max_tokens", "temperature", "top_p", "top_k", "stop", "seed",
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
 * candidate's server easily fires several calls at once. Storage reads and writes here are
 * synchronous, so check-and-reserve is atomic. The alarm drops the tally when the key expires.
 */
export class LlmBudget {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(req) {
    const { op, micros = 0, limitMicros = 0, expiresAt } = await req.json();
    const kv = this.storage.kv;
    const spent = kv.get("spentMicros") ?? 0;
    if (op === "read") return Response.json({ spentMicros: spent });

    if (op === "reserve") {
      const hold = Math.max(0, Math.round(micros));
      if (spent + hold > limitMicros) return Response.json({ ok: false, spentMicros: spent });
      kv.put("spentMicros", spent + hold);
      if (expiresAt) await this.storage.setAlarm(expiresAt);
      return Response.json({ ok: true, spentMicros: spent + hold });
    }

    // The difference between the bill and the reservation; negative is a refund.
    if (op === "settle") {
      const next = Math.max(0, spent + Math.round(micros));
      kv.put("spentMicros", next);
      return Response.json({ spentMicros: next });
    }

    return Response.json({ error: "unknown op" }, { status: 400 });
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
  return r.json();
}

/** What the key has spent so far, in dollars; 0 where no meter is bound. */
export async function spentUsd(env, tokenHash) {
  if (!env.LLM_BUDGET) return 0;
  return toUsd((await meter(env, tokenHash, "read")).spentMicros);
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

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value ?? null)).length;

/**
 * The most a call can cost. Byte-level tokenizers make at most one token per UTF-8 byte, so
 * the input's bytes bound its tokens; max_tokens bounds the output, reasoning included.
 */
function worstCaseUsd(body) {
  const input = bytes(body.messages) + bytes(body.tools) + bytes(body.response_format) +
    body.messages.length * PER_MESSAGE_TOKENS;
  return (input + body.max_tokens) * CEILING_USD_PER_TOKEN;
}

const ROLES = ["system", "developer", "user", "assistant", "tool"];
const MESSAGE_FIELDS = ["role", "content", "name", "tool_calls", "tool_call_id"];

/**
 * Text only. Images, audio and files are billed by rules a byte count does not bound, so the
 * reservation could not cover them. Returns the message as forwarded, or null.
 */
function textMessage(message) {
  if (!message || typeof message !== "object" || !ROLES.includes(message.role)) return null;
  const { content } = message;
  const isText = typeof content === "string" ||
    (content == null && message.role === "assistant") ||
    (Array.isArray(content) && content.every((part) =>
      part?.type === "text" && typeof part.text === "string"));
  if (!isText) return null;
  const parts = Array.isArray(content) ? content.map(({ text }) => ({ type: "text", text })) : content;
  const kept = Object.fromEntries(MESSAGE_FIELDS.filter((k) => k in message).map((k) => [k, message[k]]));
  return { ...kept, content: parts };
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
  const messages = body.messages.map(textMessage);
  if (messages.includes(null)) {
    return { error: "messages may carry text only: a string content or parts of type \"text\"" };
  }
  if (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.every((t) => t?.type === "function"))) {
    return { error: "tools may only be of type \"function\"" };
  }
  if (body.n !== undefined && body.n !== 1) return { error: "n must be 1" };

  const cap = maxTokens(env);
  const asked = body.max_tokens ?? body.max_completion_tokens;
  if (asked !== undefined && !(Number.isInteger(asked) && asked > 0 && asked <= cap)) {
    return { error: `max_tokens must be an integer between 1 and ${cap}` };
  }

  const forwarded = Object.fromEntries(FORWARDED.filter((k) => k in body).map((k) => [k, body[k]]));
  return {
    body: { ...forwarded, messages, max_tokens: asked ?? cap, stream: false, usage: { include: true } },
  };
}

/**
 * Handles everything under /llm/v1/. `json` carries the CORS headers; `refuse` also logs
 * the refusal, without the key.
 */
export async function handleLlm(req, env, ctx, { path, json, refuse }) {
  const refused = (reason, status, message, type = "invalid_request_error") => {
    refuse(reason);
    return json(failure(message, type), status);
  };

  if (!(await withinLimit(env.LLM_LIMIT, `ip:${clientIp(req)}`))) {
    return refused("llm_ip_rate_limited", 429, "too many requests", "rate_limit_error");
  }
  const token = presentedToken(req);
  const raw = token && env.KEYS ? await env.KEYS.get(`key:${token}`) : null;
  const record = raw === null ? null : JSON.parse(raw);
  // KV drops an expired key on its own, but not to the second.
  if (!record || (record.expiresAt && record.expiresAt <= Date.now())) {
    return refused("llm_key_invalid", 401, "invalid interview key", "authentication_error");
  }
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
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return refused("llm_body_too_large", 413, "request body too large");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused("llm_bad_json", 400, "body must be JSON");
  }
  const built = upstreamBody(parsed, env);
  if (built.error) return refused("llm_bad_request", 400, built.error);

  // The worst case is taken from the budget before the call, so parallel calls cannot
  // overspend it together, and a caller who hangs up mid-call keeps paying the reservation.
  const budget = budgetUsdOf(record);
  const hold = toMicros(worstCaseUsd(built.body));
  const reserved = await meter(env, tokenHash, "reserve", {
    micros: hold,
    limitMicros: toMicros(budget),
    expiresAt: record.expiresAt,
  });
  if (!reserved.ok) {
    const spent = toUsd(reserved.spentMicros);
    return refused(
      "llm_budget_exhausted",
      402,
      `this key has used its LLM budget: $${spent.toFixed(2)} of $${budget.toFixed(2)}; ` +
        `this call needs up to $${toUsd(hold).toFixed(2)}, a smaller max_tokens or prompt needs less`,
      "insufficient_quota",
    );
  }
  // waitUntil, so the refund still lands if the caller is gone by then.
  const settle = (billedUsd) => {
    const done = meter(env, tokenHash, "settle", { micros: toMicros(billedUsd) - hold });
    ctx?.waitUntil?.(done);
    return done;
  };

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
    await settle(0);
    return json(failure("llm provider unreachable", "server_error"), 502);
  }

  const answer = redact(await upstream.text(), env.OPENROUTER_API_KEY);
  let payload = null;
  try {
    payload = JSON.parse(answer);
  } catch {
    // Not JSON: nothing to charge and nothing worth relaying.
  }

  // No cost reported: the reservation stands, which is never less than the bill.
  const billed = typeof payload?.usage?.cost === "number" ? payload.usage.cost : null;
  if (billed === null && upstream.ok) {
    console.log(JSON.stringify({ reason: "llm_cost_missing", path, model: built.body.model }));
  }
  // An error answer without usage was not billed.
  await settle(billed ?? (upstream.ok ? toUsd(hold) : 0));

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
  return json(payload);
}
