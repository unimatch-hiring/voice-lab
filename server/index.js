/**
 * Entry point of the local history server: the only file that touches the network, the
 * filesystem and the environment. It adapts node:http to the web-standard Request/Response
 * that app.js speaks and opens the SQLite file the store works on.
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { ConversationStore } from "./store.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ALLOWED_ORIGINS =
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173";

function readConfig(env) {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8788),
    databasePath: resolve(REPOSITORY_ROOT, env.HISTORY_DB ?? "server/data/history.sqlite"),
    allowedOrigins: (env.HISTORY_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
  };
}

const BODYLESS_METHODS = ["GET", "HEAD"];
export const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super(`request body is over ${MAX_BODY_BYTES} bytes`);
  }
}

/**
 * Reads a body of at most MAX_BODY_BYTES. The origin check needs the whole request, so
 * without a cap any web page could make the server buffer a body of any size.
 */
async function readBody(incoming) {
  if (Number(incoming.headers["content-length"]) > MAX_BODY_BYTES) throw new BodyTooLargeError();

  const chunks = [];
  let receivedBytes = 0;
  // destroyOnReturn: false keeps the socket alive, so the 413 can still be written to it.
  for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Builds a web-standard Request from a node:http request, reading its body to the end.
 * @throws {BodyTooLargeError} when the body is over MAX_BODY_BYTES
 */
export async function toRequest(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of [value].flat()) headers.append(name, item);
  }

  const init = { method: incoming.method, headers };
  if (!BODYLESS_METHODS.includes(incoming.method)) {
    init.body = await readBody(incoming);
  }
  return new Request(`http://${incoming.headers.host}${incoming.url}`, init);
}

/** Writes a web-standard Response to a node:http response. */
export async function sendResponse(outgoing, response) {
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(body);
}

/** @param {(request: Request) => Promise<Response>} app */
export function createRequestListener(app) {
  return async (incoming, outgoing) => {
    try {
      await sendResponse(outgoing, await app(await toRequest(incoming)));
    } catch (error) {
      if (error instanceof BodyTooLargeError && !outgoing.headersSent) {
        // The rest of the body is left unread, so the connection is closed after the answer.
        await sendResponse(
          outgoing,
          Response.json({ error: "body too large" }, { status: 413, headers: { connection: "close" } }),
        );
        return;
      }
      console.error(error);
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      await sendResponse(
        outgoing,
        Response.json({ error: "internal error" }, { status: 500 }),
      );
    }
  };
}

/** Explains a taken port in one line instead of a stack trace; any other listen error stays loud. */
export function handleListenError(error, port, exit = process.exit) {
  if (error.code !== "EADDRINUSE") throw error;
  console.error(`port ${port} is already in use: stop the other process or set PORT to a free port`);
  exit(1);
}

function start() {
  const { host, port, databasePath, allowedOrigins } = readConfig(process.env);
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const app = createApp(new ConversationStore(database), { allowedOrigins });
  const server = createServer(createRequestListener(app));

  const shutdown = () => {
    server.close();
    database.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.on("error", (error) => handleListenError(error, port));
  server.listen(port, host, () => {
    console.log(`history server on http://${host}:${port}, database ${databasePath}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) start();
