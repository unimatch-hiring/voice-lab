import { expect, test } from "vitest";
import { coveredMs } from "./coverage";

test("overlapping stages are counted once, not added up", () => {
  expect(coveredMs([[0, 1000], [200, 600]])).toBe(1000);
});

test("partly overlapping stages count their union", () => {
  expect(coveredMs([[0, 500], [300, 900]])).toBe(900);
});

test("a gap between stages is not counted", () => {
  expect(coveredMs([[0, 100], [300, 400]])).toBe(200);
});

test("order of arrival does not matter", () => {
  expect(coveredMs([[300, 900], [0, 500]])).toBe(900);
});

test("nothing measured is zero", () => {
  expect(coveredMs([])).toBe(0);
});
