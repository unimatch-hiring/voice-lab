import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

describe("cursor", () => {
  it("round-trips", () => {
    const next = { startedAt: 1_700_000_000_000, id: "conversation-1" };
    expect(decodeCursor(encodeCursor(next))).toEqual(next);
  });

  it("produces a URL-safe string", () => {
    expect(encodeCursor({ startedAt: 1, id: "???>>>" })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

  it.each([
    ["garbage", "!!not a cursor!!"],
    ["an empty string", ""],
    ["a non-string", null],
    ["JSON that is not an object", encode("text")],
    ["a cursor missing id", encode({ startedAt: 1 })],
    ["a cursor with an empty id", encode({ startedAt: 1, id: "" })],
    ["a cursor missing startedAt", encode({ id: "c1" })],
    ["a cursor with a string startedAt", encode({ startedAt: "1", id: "c1" })],
  ])("decodes %s to null", (_name, value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});
