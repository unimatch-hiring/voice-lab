import { expect, test, vi } from "vitest";
import { sessionQuestions } from "./trainingQuestion";
import type { Transport } from "./transport";

const question = (id: number) => ({
  id,
  text: "Назовите ИКСА.",
  answer: "Плот",
  zachet: null,
  comment: null,
  takePercent: 80,
  url: `https://gotquestions.online/question/${id}`,
});

const transportWith = (trainingQuestions: Transport["trainingQuestions"]) =>
  ({ trainingQuestions: vi.fn(trainingQuestions) }) as unknown as Transport & {
    trainingQuestions: ReturnType<typeof vi.fn>;
  };

test("draws one question per skill for the audience in a single request", async () => {
  const transport = transportWith(async () => [question(1), null, question(3)]);

  const drawn = await sessionQuestions(transport, "students");

  expect(transport.trainingQuestions, "one request, so a start spends one of the key's budget").toHaveBeenCalledTimes(1);
  expect(transport.trainingQuestions).toHaveBeenCalledWith({
    skills: ["replacement", "homogeneous", "any"],
    audience: "students",
  });
  expect(drawn.map((d) => [d.skill, d.question.id])).toEqual([
    ["replacement", 1],
    ["any", 3],
  ]);
});

test("a failed or slow draw costs the list, never the start", async () => {
  const failing = transportWith(async () => {
    throw new Error("404");
  });
  expect(await sessionQuestions(failing, "school")).toEqual([]);

  const stuck = transportWith(() => new Promise(() => {}));
  expect(await sessionQuestions(stuck, "school", 10)).toEqual([]);
});
