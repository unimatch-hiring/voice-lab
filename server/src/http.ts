import type { DatabaseSync } from "node:sqlite";
import { isUuid, type ChildProfile } from "../../shared/child.ts";
import { createAlertsStore } from "./alerts-store.ts";
import { openDatabase } from "./database.ts";
import { createParentApi } from "./parent-api.ts";
import { createParentStore, type SavedProfile } from "./parent-store.ts";
import { browserResponse, error, isJsonRequest, isRecord, LOCAL_BROWSER_ORIGINS, readPayload } from "./request.ts";
import type { TurnDebugLog } from "./turn-debug.ts";
import { createTurnReviews } from "./turn-reviews.ts";

interface AppOptions {
  db?: DatabaseSync;
  fetchImpl?: typeof fetch;
  parentOrigins?: readonly string[];
  childOrigins?: readonly string[];
  openRouterKey?: string;
  turnDebugLog?: TurnDebugLog;
}

function promptProfile({ child, topics }: SavedProfile): ChildProfile {
  const { displayName, age, note, rulesVersion } = child;
  const description = displayName + (age === null ? "" : ", age " + age);
  const forbiddenTopics = topics.map(({ label }) => "- " + label).join("\n");
  const prompt = [
    "You are a kind voice assistant speaking with a child.",
    "Child profile: " + description,
    note && "Parent's note for choosing tone and examples only: " + JSON.stringify(note),
    "Reply in English, even if the child speaks another language.",
    "Use age-appropriate words and one or two short sentences.",
    "If the child directly asks to discuss a forbidden topic, gently lead them to another topic.",
    "Treat passing mentions differently from requests to discuss a topic.",
    "If the child describes fear, harm, or being unsafe, acknowledge how they feel and encourage them to talk to a trusted adult.",
    forbiddenTopics && "Forbidden topics:\n" + forbiddenTopics,
  ].filter(Boolean).join("\n\n");
  return { displayName, prompt, rulesVersion };
}

export function createApp({
  db = openDatabase(":memory:"),
  fetchImpl = fetch,
  parentOrigins,
  childOrigins = LOCAL_BROWSER_ORIGINS,
  openRouterKey,
  turnDebugLog,
}: AppOptions = {}) {
  const store = createParentStore(db);
  const alerts = createAlertsStore(db);
  const parentApi = createParentApi(store, alerts, parentOrigins);
  const review = createTurnReviews(store, alerts, fetchImpl, openRouterKey, turnDebugLog);

  async function registerConversation(request: Request) {
    const payload = await readPayload(request);
    if (payload instanceof Response) return payload;
    if (!isRecord(payload) || !isUuid(payload.childId)) return error(400, "Invalid childId");
    const childId = payload.childId.toLowerCase();
    const version = payload.rulesVersion;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      return error(400, "Invalid rules version");
    }
    if (!store.profile(childId, version)) return error(404, "Child profile or rules version not found");

    const conversationId = alerts.startConversation(childId, version);
    return Response.json({ conversationId }, { status: 201 });
  }

  async function endConversation(request: Request, id: string) {
    const payload = await readPayload(request);
    if (payload instanceof Response) return payload;
    if (!isRecord(payload) || !isUuid(id) || !isUuid(payload.childId) ||
        (payload.status !== "ended" && payload.status !== "failed")) {
      return error(400, "Invalid conversation ending");
    }
    const conversationId = id.toLowerCase();
    const child = payload.childId.toLowerCase();
    if (!alerts.conversation(conversationId, child)) return error(404, "Child conversation not found");
    alerts.endConversation(conversationId, child, payload.status);
    return new Response(null, { status: 204 });
  }

  return async function handle(request: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname.startsWith("/api/parent/")) return parentApi(request, pathname);
    const start = pathname === "/api/child/conversations";
    const end = /^\/api\/child\/conversations\/([^/]+)\/end$/.exec(pathname);
    if (start || pathname === "/api/child/turn-reviews" || end) {
      return browserResponse(request, childOrigins, "POST, OPTIONS", () => {
        if (request.method !== "POST") return error(405, "Method not allowed");
        if (!isJsonRequest(request)) return error(415, "Expected application/json");
        if (end) return endConversation(request, end[1]);
        return start ? registerConversation(request) : review(request);
      });
    }
    if (pathname === "/profile") {
      return browserResponse(request, childOrigins, "GET, OPTIONS", () => {
        if (request.method !== "GET") return error(405, "Method not allowed");
        const id = searchParams.get("childId");
        if (!isUuid(id)) return error(400, "Invalid childId");
        const selected = store.profile(id.toLowerCase());
        return selected ? Response.json(promptProfile(selected)) : error(404, "Child profile not found");
      });
    }
    return error(404, "Not found");
  };
}
