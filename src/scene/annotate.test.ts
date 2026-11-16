import { expect, test } from "vitest";
import { annotate, type Mark } from "./annotate";

const OIL = ["Замена масла", "Oil change", "2500", "30"];
const marked = (text: string, facts: string[], mark: Mark) =>
  annotate(text, facts)
    .filter((s) => s.mark === mark)
    .map((s) => s.text);

test("a catalog price and name are facts however the price is written", () => {
  for (const price of ["2500", "2 500", "2 500 ₽", "2 500 рублей"]) {
    expect(marked(`Замену масла сделаем за ${price}.`, OIL, "fact")).toEqual(["Замену масла", price]);
  }
  expect(marked("An oil change takes 30 minutes.", OIL, "fact")).toEqual(["oil change", "30 minutes"]);
});

test("an invented price and an invented time are assumptions", () => {
  const facts = [...OIL, "2026-11-17", "10:30", "12:00"];
  expect(marked("Это будет 3 000 ₽, подъезжайте в 11:15.", facts, "assumption")).toEqual(["3 000 ₽", "11:15"]);
  expect(marked("Свободно в 10:30 17 ноября.", facts, "fact")).toEqual(["10:30", "17"]);
});

test("hedge words are assumptions in both languages", () => {
  expect(marked("Предположительно, это колодки.", OIL, "assumption")).toEqual(["Предположительно"]);
  expect(marked("I assume it is the pads, probably.", OIL, "assumption")).toEqual(["I assume", "probably"]);
  // A word that merely contains a hedge is not one.
  expect(marked("Это невозможно.", OIL, "assumption")).toEqual([]);
});

test("a phone read back in pieces is not flagged", () => {
  expect(marked("Ваш номер 900 123 45 67, верно?", ["+7 900 123-45-67"], "assumption")).toEqual([]);
});

test("the segments rebuild the reply exactly", () => {
  const text = "Примерно 2 500 ₽ за Замену масла, в 9:00.";
  expect(annotate(text, [...OIL, "09:00"]).map((s) => s.text).join("")).toBe(text);
});
