const ALLOWED_TOKEN_TYPES = new Set(["batch_scribe", "realtime_scribe", "tts_websocket"]);

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
    "access-control-allow-headers": "content-type,x-vibe-token",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-max-age": "86400", // a day: no preflight on every request
    vary: "Origin",
  };
}

export default {
  async fetch(req, env) {
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
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (req.headers.get("x-vibe-token") !== env.VIBE_TOKEN) return json({ error: "nope" }, 401);

    const path = new URL(req.url).pathname;

    if (path.startsWith("/token/")) {
      const type = path.slice("/token/".length);
      if (!ALLOWED_TOKEN_TYPES.has(type)) return json({ error: "unknown token type" }, 400);

      const r = await fetch(`https://api.elevenlabs.io/v1/single-use-token/${type}`, {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
      });
      if (!r.ok) return json({ error: "upstream failed", status: r.status }, 502);
      return new Response(await r.text(), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    // Text, not audio: OpenRouter has no single-use tokens, so we proxy the LLM.
    // The model sits behind config; the client has no reason to change it.
    if (path === "/llm") {
      const body = await req.json();
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env.LLM_MODEL,
          messages: body.messages,
          stream: true,
          max_tokens: 200,
        }),
      });
      if (!r.ok) return json({ error: "upstream failed", status: r.status }, 502);
      // SSE across CORS: stream the body as-is, same headers as everything else.
      return new Response(r.body, {
        headers: { "content-type": "text/event-stream", ...cors },
      });
    }

    return json({ error: "not found" }, 404);
  },
};
