export type Route = "app" | "admin" | "admin-unavailable" | "bench" | "history";

/**
 * GitHub Pages has no rewrites, so pages besides the instrument are reached by query
 * string: a real path would 404 before React runs. A preview build answers ?admin with a
 * notice instead of the sign-in, so it never reads or writes the admin session.
 */
export function pickRoute(search: string, preview: boolean): Route {
  const params = new URLSearchParams(search);
  if (params.has("admin")) return preview ? "admin-unavailable" : "admin";
  if (params.has("bench")) return "bench";
  if (params.has("history")) return "history";
  return "app";
}

/** The conversation `?history=<id>` opens; null for the list (`?history`). */
export function historyIdFrom(search: string): string | null {
  return new URLSearchParams(search).get("history") || null;
}

/** Where a conversation's page lives. */
export function historyHref(conversationId: string): string {
  return `?history=${encodeURIComponent(conversationId)}`;
}
