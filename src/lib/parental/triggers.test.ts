import { describe, expect, it } from "vitest";
import { findTriggers, parseTriggerWords } from "./triggers";

describe("alarm phrases", () => {
  it("catches a default phrase whatever the case and the spelling of ё", () => {
    expect(findTriggers("Папа МЕНЯ БЬЁТ, когда мамы нет")).toEqual(["бьет"]);
  });

  it("matches any word form, not only the exact phrase", () => {
    expect(findTriggers("Я убью себя")).toContain("убью");
    expect(findTriggers("Хочу себя убить")).toContain("убить");
  });

  it("catches the parent's own words", () => {
    expect(findTriggers("Он сказал, что это Тайна", ["тайна"])).toContain("тайна");
  });

  it("stays quiet on an ordinary message", () => {
    expect(findTriggers("Расскажи про динозавров", ["тайна"])).toEqual([]);
  });

  it("reads the parent's field as lines or comma-separated phrases", () => {
    expect(parseTriggerWords("Тайна, страшный дядя\n\n  уйти из дома ")).toEqual([
      "тайна",
      "страшный дядя",
      "уйти из дома",
    ]);
  });
});
