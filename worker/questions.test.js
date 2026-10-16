import { describe, expect, it, vi } from "vitest";
import { findQuestions, fits, packQuestions, POOLS, SKILLS } from "./questions.js";

/** A question the way gotquestions.online serialises it; `take` is its share of teams in percent. */
function question(id, text, { take, answer = "Ответ", ...rest } = {}) {
  return {
    id,
    number: id % 100,
    text,
    razdatkaText: null,
    razdatkaPic: null,
    answer,
    zachet: null,
    comment: "Комментарий.",
    takenDown: false,
    complexity: take === undefined ? [] : [take.toFixed(2)],
    ...rest,
  };
}

/** A pack page: the questions inside the flight payload, split across pushes the way Next.js does. */
function packPage(questions) {
  const flight = `5:["$","div",null,{"questions":${JSON.stringify(questions)}}]\n`;
  const cut = Math.floor(flight.length / 2);
  const push = (part) => `<script>self.__next_f.push([1,${JSON.stringify(part)}])</script>`;
  return `<html><body>${push(flight.slice(0, cut))}${push(flight.slice(cut))}</body></html>`;
}

const REPLACEMENT = "В рассказе ИКС путешествует по реке на плоту. Назовите ИКСА.";
const HOMOGENEOUS = "Эта птица зимует в городе и не улетает на юг. Назовите эту птицу.";
const PLAIN = "Сколько ног у паука?";

describe("reading a pack page", () => {
  it("finds every question in the flight payload, braces and quotes in texts included", () => {
    const qs = [question(1, 'Скобка "}" в кавычках и {x}.'), question(2, PLAIN)];
    expect(packQuestions(packPage(qs)).map((q) => [q.id, q.text])).toEqual([
      [1, 'Скобка "}" в кавычках и {x}.'],
      [2, PLAIN],
    ]);
  });

  it("keeps a question the payload repeats once", () => {
    const q = question(1, PLAIN);
    expect(packQuestions(packPage([q, q]))).toHaveLength(1);
  });
});

describe("telling a skill from the question text", () => {
  it("sees a replaced word, through a stress mark and in a declined form", () => {
    expect(SKILLS.replacement(question(1, REPLACEMENT))).toBe(true);
    expect(SKILLS.replacement(question(2, "Он любил ДЕ\u0301ЛАТЬ по утрам."))).toBe(true);
    expect(SKILLS.replacement(question(3, "Он говорил, что эта река течёт на север."))).toBe(false);
  });

  it("sees an answer drawn from a kind of things", () => {
    expect(SKILLS.homogeneous(question(1, HOMOGENEOUS))).toBe(true);
    expect(SKILLS.homogeneous(question(2, "Назовите имя этого героя."))).toBe(true);
    expect(SKILLS.homogeneous(question(3, PLAIN))).toBe(false);
  });
});

describe("matching the audience", () => {
  const school = { skill: "any", audience: "school" };
  const students = { skill: "any", audience: "students" };

  it("gives schoolchildren questions most teams took, or ones not played yet", () => {
    expect(fits(question(1, PLAIN, { take: 89.5 }), school)).toBe(true);
    expect(fits(question(2, PLAIN), school)).toBe(true);
    expect(fits(question(3, PLAIN, { take: 10.5 }), school)).toBe(false);
  });

  it("gives students questions in the middle band, and only played ones", () => {
    expect(fits(question(1, PLAIN, { take: 33 }), students)).toBe(true);
    expect(fits(question(2, PLAIN, { take: 90 }), students)).toBe(false);
    expect(fits(question(3, PLAIN, { take: 5 }), students)).toBe(false);
    expect(fits(question(4, PLAIN), students)).toBe(false);
  });

  it("leaves out what a voice cannot play: handouts, blitzes, withdrawn questions", () => {
    for (const q of [
      question(1, PLAIN, { razdatkaText: "Текст раздатки" }),
      question(2, PLAIN, { razdatkaPic: "/pic.png" }),
      question(3, "Блиц. Три вопроса.", { answer: "1) Да. 2) Нет. 3) Да." }),
      question(4, PLAIN, { takenDown: true }),
    ]) {
      expect(fits(q, school), String(q.id)).toBe(false);
    }
  });
});

describe("drawing questions", () => {
  const page = (qs) => vi.fn(async () => new Response(packPage(qs)));

  it("fetches a pack of the audience's pool, cached at the edge, and returns the question with its link", async () => {
    const fetchImpl = page([question(42, REPLACEMENT, { take: 80 }), question(43, PLAIN, { take: 80 })]);
    const [q] = await findQuestions({ skills: ["replacement"], audience: "school" }, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(POOLS.school.packs).toContain(Number(url.split("/").pop()));
    expect(init.cf).toEqual({ cacheTtl: 86400, cacheEverything: true });
    expect(q).toMatchObject({ id: 42, text: REPLACEMENT, takePercent: 80, url: "https://gotquestions.online/question/42" });
  });

  it("gives each skill its own question from the same pack pages, each read once", async () => {
    const fetchImpl = page([question(42, PLAIN), question(43, PLAIN)]);
    const drawn = await findQuestions({ skills: ["any", "any", "any"], audience: "school" }, { fetchImpl });

    expect(drawn.slice(0, 2).map((q) => q.id).sort()).toEqual([42, 43]);
    expect(drawn[2], "two questions cannot serve three skills").toBeNull();
    expect(fetchImpl, "two packs, not two per skill").toHaveBeenCalledTimes(2);
  });

  it("tries a second pack and then gives up, rather than walking the whole site", async () => {
    const fetchImpl = page([question(1, PLAIN)]);
    expect(await findQuestions({ skills: ["replacement"], audience: "school" }, { fetchImpl })).toEqual([null]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports the site refusing instead of passing its page off as empty", async () => {
    const fetchImpl = vi.fn(async () => new Response("slow down", { status: 429 }));
    await expect(findQuestions({ skills: ["any"], audience: "school" }, { fetchImpl })).rejects.toThrow("429");
  });
});
