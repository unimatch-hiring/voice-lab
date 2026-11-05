export type Route = "app" | "admin" | "admin-unavailable" | "bench";

/**
 * GitHub Pages has no rewrites, so pages besides the instrument are reached by query
 * string: a real path would 404 before React runs. A preview build answers ?admin with a
 * notice instead of the sign-in, so it never reads or writes the admin session.
 */
export function pickRoute(search: string, preview: boolean): Route {
  const params = new URLSearchParams(search);
  if (params.has("admin")) return preview ? "admin-unavailable" : "admin";
  if (params.has("bench")) return "bench";
  return "app";
}
