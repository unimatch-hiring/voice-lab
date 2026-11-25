import { describe, expect, it } from "vitest";
import { historyHref, historyIdFrom, pickRoute } from "./route";

describe("pickRoute", () => {
  it("opens the admin page on the main site", () => {
    expect(pickRoute("?admin", false)).toBe("admin");
  });

  it("keeps a preview build away from the admin page", () => {
    expect(pickRoute("?admin", true)).toBe("admin-unavailable");
  });

  it("still serves the instrument in a preview build", () => {
    expect(pickRoute("", true)).toBe("app");
  });

  it("opens the bench", () => {
    expect(pickRoute("?bench", false)).toBe("bench");
  });

  it("opens the history list and a conversation from it", () => {
    expect(pickRoute("?history", false)).toBe("history");
    expect(pickRoute("?history=conv_1", false)).toBe("history");
  });
});

describe("history addresses", () => {
  it("reads no conversation id for the list", () => {
    expect(historyIdFrom("?history")).toBeNull();
  });

  it("reads back the id a conversation link carries", () => {
    expect(historyIdFrom(historyHref("conv/1 & 2"))).toBe("conv/1 & 2");
  });
});
