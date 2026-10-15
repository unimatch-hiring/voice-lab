import { expect, test } from "vitest";
import { coachKnowledge, createKnowledge, sectionsOf, stems } from "./knowledge";

const titles = (material: string | null) =>
  (material ?? "")
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3));

const FILES = [
  "# Брейн-ринг\n\nИсточник: правила.\n\n## Брейн-ринг: фальстарт\nФальстарт — нажатие кнопки до сигнала ведущего; команда теряет право ответа.\n\n## Брейн-ринг: время\nНа ответ даётся двадцать секунд после сигнала.",
  "# Этика\n\nИсточник: кодекс.\n\n## Этика ЧГК: засветка\nЗасветка — разглашение вопроса до окончания синхрона. Команда, которая засветила вопрос, отвечает за это.\n\n## Этика ЧГК: команда\nКоманда уважает соперников, команда не спорит с ведущим, команда благодарит.",
  // Unrelated sections give the ranking a corpus to weigh words against, as the real base does.
  "# Разное\n\nИсточник: тренеры.\n\n" +
    ["разминка", "музыка", "рисунок", "театр", "шахматы", "танцы", "поход", "кино", "пение", "лепка"]
      .map((topic) => `## Разное: ${topic}\nКоманда занимается: ${topic}, ${topic} и снова ${topic}.`)
      .join("\n\n"),
];

test("a section is one ## heading with its text; the file heading and source line are left out", () => {
  expect(sectionsOf(FILES.slice(0, 2)).map((s) => s.title)).toEqual([
    "Брейн-ринг: фальстарт",
    "Брейн-ринг: время",
    "Этика ЧГК: засветка",
    "Этика ЧГК: команда",
  ]);
  expect(sectionsOf(FILES)[0].text).not.toContain("Источник");
});

test("word forms meet on a shared stem, and ё reads as е", () => {
  expect(stems("замена замену заменой")).toEqual(["замен", "замен", "замен"]);
  expect(stems("Ещё всё её")).toEqual([]);
  expect(stems("сдаёт")).toEqual(stems("сдает"));
});

test("finds the section a question is about, in another word form", () => {
  const search = createKnowledge(FILES);
  expect(titles(search("Что будет за фальстарты?"))[0]).toBe("Брейн-ринг: фальстарт");
  expect(titles(search("кто-то засветил вопрос"))[0]).toBe("Этика ЧГК: засветка");
});

test("small talk and words in most sections find nothing", () => {
  const search = createKnowledge(FILES);
  expect(search("Привет, как дела?")).toBeNull();
  expect(search("")).toBeNull();
  expect(search("команда")).toBeNull();
});

test("the material says what it is, so the prompt can point at it", () => {
  expect(createKnowledge(FILES)("фальстарт")).toMatch(/^Knowledge base material/);
});

test("the coach's real base answers the questions a coach brings", () => {
  expect(titles(coachKnowledge("Что такое фальстарт в брейн-ринге?"))[0]).toBe("Брейн-ринг: фальстарт");
  expect(titles(coachKnowledge("Что такое засветка?"))[0]).toMatch(/засветка/);
  expect(titles(coachKnowledge("Как подать апелляцию?"))[0]).toMatch(/апелляции/);
  expect(titles(coachKnowledge("Как составить свой вопрос для тренировки?"))[0]).toMatch(/^Составить вопрос ЧГК/);
  expect(
    titles(coachKnowledge("Как команде тренировать замену слова?"))[0],
    "«команда», in most sections, must not outweigh «замена»",
  ).toBe("Раскрутка ЧГК: замена слова");
});

test("long sections are cut to a turn's worth of background, keeping at least the best one", () => {
  const long = (n: number) => `## Фальстарт: случай ${n}\n${"Фальстарт до сигнала. ".repeat(100)}`;
  const search = createKnowledge([`# Длинное\n\nИсточник: x.\n\n${[1, 2, 3].map(long).join("\n\n")}`, FILES[2]]);
  const material = search("фальстарт") ?? "";
  expect(titles(material)).toHaveLength(1);
  expect(material.length).toBeGreaterThan(2000);
});
