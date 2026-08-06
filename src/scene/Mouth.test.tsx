import { expect, test } from "vitest";
import { MOUTH_SHAPES } from "./Mouth";

test("ships a path for every viseme", () => {
  const visemes = ["rest", "MBP", "AI", "E", "O", "U", "FV", "L", "WQ"] as const;
  for (const v of visemes) {
    expect(MOUTH_SHAPES[v], `нет формы для ${v}`).toBeTruthy();
    expect(MOUTH_SHAPES[v].startsWith("M")).toBe(true); // валидный SVG-path
  }
});

test("closed and open shapes differ", () => {
  expect(MOUTH_SHAPES.MBP).not.toBe(MOUTH_SHAPES.AI);
  expect(MOUTH_SHAPES.rest).not.toBe(MOUTH_SHAPES.O);
});
