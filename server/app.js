/**
 * HTTP layer of the history server: a pure function from a web-standard Request to a
 * Response. It only routes and maps store statuses to HTTP statuses; parsing lives in
 * validation.js and userId.js, storage in store.js.
 */
import { hashUserId, parseUserId } from "./userId.js";
import { parseEntries, parseId, parseOpenBody } from "./validation.js";

const NOT_FOUND = { httpStatus: 404, error: "conversation not found" };

// How a store status that is not a success answers, one table per kind of route. Reads
// and deletes show someone else's and a deleted conversation as not found; writes say why.
const WRITE_FAILURES = {
  forbidden: { httpStatus: 403, error: "forbidden" },
  gone: { httpStatus: 410, error: "conversation was deleted" },
  "not-found": NOT_FOUND,
  "too-many-lines": { httpStatus: 400, error: "too many lines in this conversation" },
};
const LOOKUP_FAILURES = {
  forbidden: NOT_FOUND,
  gone: NOT_FOUND,
  "not-found": NOT_FOUND,
  "bad-cursor": { httpStatus: 400, error: "invalid cursor" },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const fail = (status, error) => json({ error }, status);

/** Answers a store result with its failure from `failures`, or with `succeed(result)`. */
function answer(failures, result, succeed) {
  const failure = failures[result.status];
  return failure ? fail(failure.httpStatus, failure.error) : succeed(result);
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "content-type,x-history-user",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-max-age": "86400",
  };
}

/** Names the route a path belongs to; the id is still percent-encoded. */
function matchRoute(pathname) {
  const [root, rawId, rest, ...extra] = pathname.split("/").slice(1);
  if (root !== "conversations" || extra.length > 0) return null;
  if (rawId === undefined) return { name: "collection" };
  if (rest === undefined) return { name: "conversation", rawId };
  if (rest === "entries") return { name: "entries", rawId };
  return null;
}

function decodePathSegment(rawSegment) {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function openConversation(store, request, userHash) {
  const body = parseOpenBody(await readJson(request));
  if (!body) return fail(400, "invalid body");
  const result = store.open({ userHash, ...body });
  return answer(WRITE_FAILURES, result, () => json({ id: body.conversationId }));
}

async function appendEntries(store, request, userHash, conversationId) {
  const entries = parseEntries(await readJson(request));
  if (!entries) return fail(400, "invalid body");
  const result = store.append({ userHash, conversationId, entries });
  return answer(WRITE_FAILURES, result, () => json({ ok: true }));
}

function listConversations(store, url, userHash) {
  const result = store.list({ userHash, cursor: url.searchParams.get("cursor") });
  return answer(LOOKUP_FAILURES, result, ({ conversations, nextCursor, totals }) =>
    json({ conversations, nextCursor, totals }));
}

function getConversation(store, userHash, conversationId) {
  const result = store.get({ userHash, conversationId });
  return answer(LOOKUP_FAILURES, result, ({ conversation, lines, turns }) =>
    json({ conversation, lines, turns }));
}

function removeConversation(store, userHash, conversationId) {
  const result = store.remove({ userHash, conversationId });
  return answer(LOOKUP_FAILURES, result, () => new Response(null, { status: 204 }));
}

const methodNotAllowed = () => fail(405, "method not allowed");

async function route(store, request, userHash) {
  const url = new URL(request.url);
  const matched = matchRoute(url.pathname);
  if (!matched) return fail(404, "not found");
  const { method } = request;

  if (matched.name === "collection") {
    if (method === "POST") return openConversation(store, request, userHash);
    if (method === "GET") return listConversations(store, url, userHash);
    return methodNotAllowed();
  }

  const conversationId = parseId(decodePathSegment(matched.rawId));
  if (!conversationId) return fail(400, "invalid conversation id");

  if (matched.name === "entries") {
    if (method === "POST") return appendEntries(store, request, userHash, conversationId);
    return methodNotAllowed();
  }
  if (method === "GET") return getConversation(store, userHash, conversationId);
  if (method === "DELETE") return removeConversation(store, userHash, conversationId);
  return methodNotAllowed();
}

/** @param {string[]} allowedOrigins browser origins that may call the API */
export function createApp(store, { allowedOrigins }) {
  return async function handle(request) {
    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.includes(origin)) return fail(403, "origin not allowed");

    const response = await respond(store, request);
    if (origin !== null) {
      for (const [name, value] of Object.entries(corsHeaders(origin))) {
        response.headers.set(name, value);
      }
    }
    return response;
  };
}

async function respond(store, request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const userId = parseUserId(request.headers.get("x-history-user"));
  if (!userId) return fail(400, "missing or invalid user id");
  return route(store, request, hashUserId(userId));
}
