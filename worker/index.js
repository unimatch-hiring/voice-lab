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

    // Session token for ElevenLabs Agents: short-lived and scoped to one conversation, so
    // it can safely reach the browser. The API key never leaves the Worker.
    if (path === "/agent/token") {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${env.AGENT_ID}`,
        { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } },
      );
      if (!r.ok) return json({ error: "upstream failed", status: r.status }, 502);
      const body = await r.json();
      return json({ token: body.token, agentId: env.AGENT_ID });
    }

    return json({ error: "not found" }, 404);
  },
};
