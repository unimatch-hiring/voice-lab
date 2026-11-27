import { expect, test } from "vitest";
import { pickRoute, routeHref } from "./route";

const childId = "a789682b-f6cc-4687-bd23-0b4839927eea";

test.each([
  ["?admin&bench", false, "admin"],
  ["?admin&bench", true, "admin-unavailable"],
  ["?bench", true, "bench"],
  ["?parent=local-parent", false, "parent"],
  ["?alerts", false, "alerts"],
] as const)("opens %s (preview %s) as %s", (search, preview, page) => {
  expect(pickRoute(search, preview)).toEqual({ page });
});

test("the unqualified parent link opens the default account at its canonical URL", () => {
  expect(pickRoute("?parent", false)).toEqual({ page: "parent", redirect: true });
  expect(pickRoute("?parent=someone-else", false)).toEqual({ page: "invalid-parent" });
  expect(pickRoute("?parent=local-parent&parent=someone-else", false)).toEqual({ page: "invalid-parent" });
});

test("the demo can opt into fixture recording", () => {
  expect(pickRoute("", true)).toEqual({ page: "app", recording: false });
  expect(pickRoute("?record", false)).toEqual({ page: "app", recording: true });
});

test("a child link takes precedence over tooling and can opt into recording", () => {
  const search = `?child=${childId.toUpperCase()}&admin&bench&record`;
  expect(pickRoute(search, false)).toEqual({ page: "app", childId, recording: true });
});

test.each(["?child", "?child=missing&admin", `?child=${childId}&child=${childId}`])(
  "displays an invalid child link for %s",
  (search) => expect(pickRoute(search, false)).toEqual({ page: "invalid-child" }),
);

test.each(["/voice-lab/", "/voice-lab-previews/branch/parent-control/", "/voice-lab-previews/pr-42/"])(
  "links under %s use its static entry",
  (base) => {
    const origin = "https://example.test";
    const child = new URL(routeHref({ childId }, base), origin);
    expect(child.pathname).toBe(base);
    expect(pickRoute(child.search, true)).toEqual({ page: "app", childId, recording: false });
    for (const page of ["parent", "alerts"] as const) {
      const url = new URL(routeHref(page, base), origin);
      expect(url.pathname).toBe(base);
      expect(url.search).toBe(page === "parent" ? "?parent=local-parent" : "?alerts");
      expect(pickRoute(url.search, true)).toEqual({ page });
    }
  },
);
