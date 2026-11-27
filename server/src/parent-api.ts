import { isUuid } from "../../shared/child.ts";
import type { ChildFields } from "../../shared/parent.ts";
import type { AlertCursor, AlertsStore } from "./alerts-store.ts";
import type { ParentStore } from "./parent-store.ts";
import { browserResponse, error, isIsoTime, isJsonRequest, isRecord, LOCAL_BROWSER_ORIGINS, readPayload } from "./request.ts";

const CHILDREN = "/api/parent/children";
const RULES = "/api/parent/rules";
const ALERTS = "/api/parent/alerts";

function parseCursor(value: string): AlertCursor | undefined {
  if (!/^[\w-]{1,160}$/.test(value)) return;
  try {
    const cursor: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (isRecord(cursor) && isIsoTime(cursor.occurredAt) && isUuid(cursor.turnId)) {
      return { occurredAt: cursor.occurredAt, turnId: cursor.turnId };
    }
  } catch {
    return;
  }
}

function isProfileText(value: unknown, maxLength: number): value is string {
  // SQLite's length() stops at the first NUL.
  return typeof value === "string" && value.length <= maxLength && !value.includes("\0");
}

function childFields(payload: unknown): ChildFields | undefined {
  if (!isRecord(payload)) return;
  const { displayName, age = null, note = "", ruleIds = [] } = payload;
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (!name || !isProfileText(name, 120) || !isProfileText(note, 4000)) return;
  if (age !== null && (typeof age !== "number" || !Number.isInteger(age) || age < 0 || age > 120)) return;
  if (!Array.isArray(ruleIds) || !ruleIds.every((id: unknown): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id >= 1)) return;
  return { displayName: name, age, note: note.trim(), ruleIds: [...new Set(ruleIds)].sort((a, b) => a - b) };
}

export function createParentApi(store: ParentStore, alerts: AlertsStore, origins: readonly string[] = LOCAL_BROWSER_ORIGINS) {
  async function alertRequest(request: Request, pathname: string) {
    if (pathname === ALERTS && request.method === "GET") {
      const params = new URL(request.url).searchParams;
      const childId = params.get("childId");
      const before = params.get("cursor");
      const cursor = before === null ? null : parseCursor(before);
      if (before !== null && !cursor) return error(400, "Invalid alert cursor");
      if (childId !== null && (!isUuid(childId) || !store.child(childId.toLowerCase()))) {
        return error(404, "Child profile not found");
      }
      return Response.json(alerts.list(childId?.toLowerCase(), cursor));
    }
    if (pathname !== ALERTS + "/read" || request.method !== "POST") return error(405, "Method not allowed");
    if (!isJsonRequest(request)) return error(415, "Expected application/json");
    const body = await readPayload(request);
    if (body instanceof Response) return body;
    const turnIds = isRecord(body) ? body.turnIds : undefined;
    if (!Array.isArray(turnIds) || turnIds.length < 1 || turnIds.length > 25 || !turnIds.every(isUuid)) {
      return error(400, "Invalid alert IDs");
    }
    alerts.markSeen([...new Set(turnIds.map((id) => id.toLowerCase()))]);
    return new Response(null, { status: 204 });
  }

  async function dispatch(request: Request, pathname: string) {
    if (pathname === ALERTS || pathname === ALERTS + "/read") return alertRequest(request, pathname);
    const method = request.method;
    const id = pathname.startsWith(CHILDREN + "/") ? pathname.slice(CHILDREN.length + 1) : null;
    if (id !== null && !isUuid(id)) return error(404, "Child profile not found");
    const childId = id?.toLowerCase();
    if (pathname !== CHILDREN && pathname !== RULES && !childId) return error(404, "Not found");

    if (method === "GET") {
      if (pathname === CHILDREN) return Response.json(store.listChildren());
      if (pathname === RULES) return Response.json(store.listRules());
      const profile = childId && store.child(childId);
      return profile ? Response.json(profile) : error(404, "Child profile not found");
    }
    if (method === "DELETE" && childId) {
      return store.deleteChild(childId)
        ? new Response(null, { status: 204 })
        : error(404, "Child profile not found");
    }
    if (method !== "POST") return error(405, "Method not allowed");
    if (!isJsonRequest(request)) {
      return error(415, "Expected application/json");
    }
    const payload = await readPayload(request);
    if (payload instanceof Response) return payload;
    if (pathname === RULES) {
      const label = isRecord(payload) && typeof payload.label === "string" ? payload.label.trim() : "";
      if (!label || !isProfileText(label, 500)) return error(400, "Enter a topic of 1–500 characters");
      const { created, rule } = store.saveRule(label);
      return Response.json(rule, { status: created ? 201 : 200 });
    }
    const fields = childFields(payload);
    if (!fields) return error(400, "Check the child's name, age, note and selected topics");
    const result = store.saveChild(childId, fields);
    if (result.error === "missing") return error(404, "Child profile not found");
    if (result.error === "invalid_rule") return error(400, "A selected topic does not exist");
    return Response.json(result.child, { status: childId ? 200 : 201 });
  }

  return (request: Request, pathname: string) => browserResponse(
    request, origins, "GET, POST, DELETE, OPTIONS", () => dispatch(request, pathname),
  );
}
