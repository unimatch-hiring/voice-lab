import { expect, test } from "vitest";
import { CLUB_SOURCES } from "./club";

/** One fact must hold every word, so a price cannot pass by sitting beside the wrong item. */
const EXPECTED: Record<string, string[][]> = {
  "club-profile": [
    ["Family Fitness"],
    ["120", "at once"],
    ["pool", "4 lanes"],
    ["children's room"],
    ["06:30", "23:00"],
  ],
  "price-list": [
    ["annual", "1000"],
    ["month", "120"],
    ["frozen", "30 days"],
    ["10 sessions", "400"],
    ["senior trainer", "60"],
    ["trainer", "45"],
    ["trial workout", "free"],
  ],
  "class-schedule": [
    ["yoga", "07:30"],
    ["aqua", "19:00"],
    ["family", "10:00"],
  ],
  equipment: [
    ["20", "cardio"],
    ["6", "rack"],
    ["dumbbells", "50"],
  ],
  trainers: [["Anna Smirnova"], ["Igor Petrov"], ["Maria Kim"]],
};

test("the club data holds each fact under its source", () => {
  expect(CLUB_SOURCES.map((s) => s.id).sort()).toEqual(Object.keys(EXPECTED).sort());

  // The numbers fixed by the brief are compared whole: "$10000" contains "1000".
  const wording = (id: string, lang: "ru" | "en") =>
    CLUB_SOURCES.find((s) => s.id === id)?.facts.map((f) => f[lang]);
  expect(wording("club-profile", "en")).toContain("The club holds 120 people at once.");
  expect(wording("club-profile", "ru")).toContain("Клуб рассчитан на 120 человек одновременно.");
  expect(wording("club-profile", "en")).toContain("The pool has 4 lanes.");
  expect(wording("club-profile", "ru")).toContain("В бассейне 4 дорожки.");
  expect(wording("price-list", "en")).toContain("The annual membership costs $1000.");
  expect(wording("price-list", "en")).toContain("A monthly subscription costs $120.");
  expect(wording("price-list", "ru")).toContain("Годовой абонемент стоит 1000 долларов.");
  expect(wording("price-list", "ru")).toContain("Подписка на месяц стоит 120 долларов.");

  for (const [id, wanted] of Object.entries(EXPECTED)) {
    const facts = wording(id, "en") ?? [];
    for (const words of wanted) {
      const found = facts.some((fact) =>
        words.every((word) => fact.toLowerCase().includes(word.toLowerCase())),
      );
      expect(found, `${id}: ${words.join(" + ")}`).toBe(true);
    }
  }
});

test("both wordings of a fact state the same numbers", () => {
  const numbers = (text: string) => (text.match(/\d+(?:[.:]\d+)*/g) ?? []).sort();

  expect(CLUB_SOURCES).toHaveLength(5);
  for (const source of CLUB_SOURCES) {
    for (const fact of source.facts) {
      expect(numbers(fact.ru), fact.en).toEqual(numbers(fact.en));
      expect(fact.ru, fact.en).not.toBe("");
    }
  }
});
