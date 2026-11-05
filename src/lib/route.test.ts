import { describe, expect, it } from "vitest";
import { pickRoute } from "./route";

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
});
