import { REQUEST_BODY_LIMIT } from "../../shared/child.ts";

export const LOCAL_BROWSER_ORIGINS = [
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:4173", "http://127.0.0.1:4173",
];

export function error(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

export function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && new Date(value).toJSON() === value;
}

export async function readPayload(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > REQUEST_BODY_LIMIT) {
    return error(413, "Request body too large");
  }
  const reader = request.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > REQUEST_BODY_LIMIT) {
        void reader.cancel().catch(() => {});
        return error(413, "Request body too large");
      }
      body += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch {
    return error(400, "Expected a JSON request");
  } finally {
    reader.releaseLock();
  }
}

export async function browserResponse(
  request: Request, origins: readonly string[], methods: string, handle: () => Response | Promise<Response>,
): Promise<Response> {
  const origin = request.headers.get("origin");
  // Clients without an Origin header rely on the deployment's private access boundary.
  const allowed = origin === null || origins.includes(origin);
  const response = !allowed ? error(403, "Origin not allowed") :
    request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await handle();
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "Origin");
  if (origin && allowed) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("access-control-allow-methods", methods);
    response.headers.set("access-control-allow-headers", "Content-Type");
  }
  return response;
}
