import { describe, expect, it } from "vitest";
import { hashUserId, parseUserId } from "./userId.js";

const V4 = "3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b";

describe("parseUserId", () => {
  it("accepts a lower-case v4 UUID", () => {
    expect(parseUserId(V4)).toBe(V4);
  });

  it("lower-cases an upper-case v4 UUID", () => {
    expect(parseUserId(V4.toUpperCase())).toBe(V4);
  });

  it.each([
    ["a short string", "123"],
    ["an empty string", ""],
    ["null", null],
    ["a v1 UUID", "3f2b8c1e-9d4a-1e6b-8a7c-1b2d3e4f5a6b"],
    ["a v4 UUID with a wrong variant", "3f2b8c1e-9d4a-4e6b-7a7c-1b2d3e4f5a6b"],
    ["a v4 UUID with trailing text", `${V4}x`],
  ])("rejects %s", (_name, value) => {
    expect(parseUserId(value)).toBeNull();
  });
});

describe("hashUserId", () => {
  it("is 64 hex characters", () => {
    expect(hashUserId(V4)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for one id", () => {
    expect(hashUserId(V4)).toBe(hashUserId(V4));
  });

  it("differs between ids", () => {
    expect(hashUserId(V4)).not.toBe(hashUserId("3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6c"));
  });
});
