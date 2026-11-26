import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHistoryStore, dialogueIdPattern, isDialogue, MalformedDialogueError } from "./historyStore.js";

const localOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];
const incompleteHeader = "X-History-Incomplete";
const collectionMethods = ["GET", "OPTIONS"];
const dialogueMethods = ["GET", "PUT", "DELETE", "OPTIONS"];

function send(response, status, body) {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function handleDialogue(request, response, store, id) {
  switch (request.method) {
    case "GET": {
      const dialogue = await store.read(id);
      if (dialogue) send(response, 200, dialogue);
      else send(response, 404, { error: "Dialogue not found." });
      break;
    }
    case "PUT": {
      const dialogue = await readJson(request);
      if (!isDialogue(dialogue, id)) {
        send(response, 400, { error: "This dialogue could not be saved." });
        break;
      }
      if (await store.save(id, dialogue)) send(response, 204);
      else send(response, 410, { error: "This dialogue was deleted." });
      break;
    }
    case "DELETE":
      await store.remove(id);
      send(response, 204);
      break;
  }
}

export function createHistoryServer({ dataDir, allowedOrigins = [] }) {
  const store = createHistoryStore(dataDir);
  const origins = new Set([...localOrigins, ...allowedOrigins]);
  return createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Origin");
    const { origin } = request.headers;
    if (origins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Expose-Headers", incompleteHeader);
    }

    const [path] = request.url.split("?");
    const isCollection = path === "/dialogues";
    const id = path.startsWith("/dialogues/") ? path.slice("/dialogues/".length) : "";
    const serverOptions = request.method === "OPTIONS" && path === "*";
    if (!isCollection && !dialogueIdPattern.test(id) && !serverOptions) {
      send(response, 404, { error: "History page not found." });
      return;
    }

    const methods = isCollection ? collectionMethods : dialogueMethods;
    if (!methods.includes(request.method)) {
      response.setHeader("Allow", methods.join(", "));
      send(response, 405, { error: "This action is not supported." });
      return;
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", methods.join(", "));
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      send(response, 204);
      return;
    }

    try {
      if (isCollection) {
        const { summaries, incomplete } = await store.list();
        if (incomplete) response.setHeader(incompleteHeader, "1");
        send(response, 200, summaries);
        return;
      }
      await handleDialogue(request, response, store, id);
    } catch (error) {
      console.error("History request failed", error);
      if (response.headersSent) response.end();
      else if (request.method === "PUT" && error instanceof MalformedDialogueError) {
        send(response, 409, { error: "This dialogue could not be saved." });
      } else {
        send(response, 500, { error: "History is unavailable. Try again." });
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dataDir = process.env.HISTORY_DATA_DIR || fileURLToPath(new URL("./data", import.meta.url));
  const allowedOrigins = (process.env.HISTORY_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const port = Number(process.env.HISTORY_PORT || 8788);
  createHistoryServer({ dataDir, allowedOrigins }).listen(port, () => {
    console.log(`Voice Lab history is listening on port ${port}.`);
  });
}
