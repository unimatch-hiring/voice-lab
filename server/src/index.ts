import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openDatabase } from "./database.ts";
import { createApp } from "./http.ts";
import { openTurnDebugLog } from "./turn-debug.ts";

function allowedOrigins(value: string | undefined) {
  return value?.split(",").map((origin) => origin.trim()).filter(Boolean);
}

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8788);
const handle = createApp({
  db: openDatabase(),
  parentOrigins: allowedOrigins(process.env.PARENT_CONTROL_ORIGINS),
  childOrigins: allowedOrigins(process.env.CHILD_VOICE_ORIGINS),
  openRouterKey: process.env.OPENROUTER_API_KEY?.trim(),
  turnDebugLog: openTurnDebugLog(process.env, host),
});

const server = createServer(async (req, res) => {
  const stop = new AbortController();
  // "close" also fires when the response finishes normally.
  res.on("close", () => {
    if (!res.writableFinished) stop.abort();
  });
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, String(value));
    }
    const method = req.method ?? "GET";
    const request = new Request(new URL(req.url ?? "/", "http://localhost"), {
      method,
      headers,
      signal: stop.signal,
      // Fetch requires half-duplex mode for a streamed request body.
      ...(method !== "GET" && method !== "HEAD"
        ? { body: Readable.toWeb(req), duplex: "half" }
        : {}),
    });
    const response = await handle(request);
    if (stop.signal.aborted) return;
    // An oversized upload can still be sending bytes when the response is ready.
    if (response.status === 413) res.shouldKeepAlive = false;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "The voice-lab server could not complete the request" } }));
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const listenPort = address && typeof address === "object" ? address.port : port;
  console.log("voice-lab server listening on http://" + host + ":" + listenPort);
});
