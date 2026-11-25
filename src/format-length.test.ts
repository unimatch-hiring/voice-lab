import { describe, expect, it } from "vitest";
import { formatLength } from "./lib/historyView";

describe("formatLength", () => {
  it.each([
    [0, "0:00"],
    [4_000, "0:04"],
    [59_999, "0:59"],
    [60_000, "1:00"],
    [408_000, "6:48"],
  ])("%i ms reads as %s", (ms, expected) => {
    expect(formatLength(ms)).toBe(expected);
  });
});
