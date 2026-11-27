import { isUuid } from "../../shared/child";
import { LOCAL_PARENT } from "../../shared/parent";

export type Route =
  | { page: "app"; recording: boolean; childId?: string }
  | { page: "parent"; redirect?: true }
  | { page: "admin" | "admin-unavailable" | "bench" | "alerts" | "invalid-child" | "invalid-parent" };

/**
 * GitHub Pages has no rewrites. A path without a built file returns HTTP 404,
 * so every view uses the query string on the same index.html.
 */
export function pickRoute(search: string, preview: boolean): Route {
  const params = new URLSearchParams(search);
  const childIds = params.getAll("child");
  const recording = params.has("record");
  if (childIds.length) {
    const [id] = childIds;
    return childIds.length === 1 && isUuid(id)
      ? { page: "app", childId: id.toLowerCase(), recording }
      : { page: "invalid-child" };
  }
  if (params.has("admin")) return { page: preview ? "admin-unavailable" : "admin" };
  if (params.has("bench")) return { page: "bench" };
  const parentIds = params.getAll("parent");
  if (parentIds.length) {
    const [id] = parentIds;
    if (parentIds.length !== 1) return { page: "invalid-parent" };
    if (id === "") return { page: "parent", redirect: true };
    return { page: id === LOCAL_PARENT ? "parent" : "invalid-parent" };
  }
  if (params.has("alerts")) return { page: "alerts" };
  return { page: "app", recording };
}

export function routeHref(route: "parent" | "alerts" | { childId: string }, base = import.meta.env.BASE_URL): string {
  if (route === "parent") return base + "?parent=" + LOCAL_PARENT;
  const search = typeof route === "string" ? route : "child=" + encodeURIComponent(route.childId);
  return base + "?" + search;
}
