import { expect, test } from "vitest";
import { describeLevel, estimateLevel, parseLevel } from "./level";

test("a learner's own word for their level is taken as the answer", () => {
  expect(parseLevel("I am B1")).toBe("B1");
  expect(parseLevel("my level is intermediate")).toBe("B1");
  expect(parseLevel("beginner I guess")).toBe("A1");
  expect(parseLevel("I think a2 maybe")).toBe("A2");
  expect(parseLevel("advanced")).toBe("C1");
});

test("upper intermediate is not intermediate", () => {
  // Order matters in the table: the longer name has to be tested first or it is
  // swallowed by the shorter one inside it.
  expect(parseLevel("upper intermediate")).toBe("B2");
  expect(parseLevel("pre-intermediate")).toBe("A2");
});

test("the answer is taken in Russian too", () => {
  // Being asked your level in a language you are still learning is the one moment
  // where reaching for Russian is an answer rather than drift.
  expect(parseLevel("я начинающий")).toBe("A1");
  expect(parseLevel("у меня средний уровень")).toBe("B1");
  expect(parseLevel("продвинутый")).toBe("C1");
});

test("not an answer is not an answer", () => {
  for (const dodge of ["I don't know", "why do you ask", "давай просто поговорим", ""]) {
    expect(parseLevel(dodge), dodge).toBeNull();
  }
});

test("an article and a number are not a CEFR code", () => {
  // Found in the sixth review: with a space allowed between the letter and the digit,
  // these read as the learner stating their level — which pinned it, wrote it down and
  // never asked again.
  for (const ordinary of [
    "I rented a 2 bedroom flat",
    "can we do a 1 hour lesson",
    "I have a 2 year old son",
  ]) {
    expect(parseLevel(ordinary), ordinary).toBeNull();
  }
  expect(parseLevel("I am b1"), "the code itself still reads").toBe("B1");
});

test("the estimate separates the three bands it claims to", () => {
  const beginner = ["I like cat", "yes is good", "I go work", "my name Ivan"];
  const middle = [
    "I usually go to the office by bus because it is faster",
    "yesterday I cooked pasta with my sister and we watched a film",
    "I think I will travel to Italy next summer if I have money",
  ];
  const advanced = [
    "I have been working in logistics for about eight years, which is longer than I expected",
    "if I had known the meeting was cancelled I would have stayed at home and finished the report",
    "although the film was beautifully shot, the plot felt derivative, so I would not watch it again",
  ];

  expect(estimateLevel(beginner)).toBe("A2");
  expect(estimateLevel(middle)).toBe("B1");
  expect(estimateLevel(advanced)).toBe("C1");
});

test("mistakes count against, in quantity rather than at all", () => {
  const clean = [
    "I usually go to the office by bus because it is faster",
    "yesterday I cooked pasta with my sister and we watched a film",
    "I think I will travel to Italy next summer if I have money",
  ];
  const sameButWrong = [
    "my sister usually go to the office by bus because she have no car",
    "yesterday she cooked pasta and she watch a film with her friend",
    "I think he go to Italy next summer if he have money",
  ];

  expect(estimateLevel(clean), "sentences of this shape are B1").toBe("B1");
  expect(estimateLevel(sameButWrong), "the same shape, wrong every time, is not").toBe("A2");
});

test("the mistakes counted are the ones in what it is listening to", () => {
  // Handed the lesson's running total instead, the count was divided by three
  // sentences — so anybody pressing "reset level" after a few corrections was
  // re-assessed downwards before they opened their mouth.
  const advanced = [
    "I have been working in logistics for about eight years, which is longer than I expected",
    "if I had known the meeting was cancelled I would have stayed at home and finished the report",
    "although the film was beautifully shot, the plot felt derivative, so I would not watch it again",
  ];
  expect(estimateLevel(advanced), "clean speech, whatever the history").toBe("C1");
});

test("nothing to go on does not produce a confident answer", () => {
  expect(estimateLevel([])).toBe("A2");
});

test("a guess says it is a guess", () => {
  expect(describeLevel({ level: "B1", source: "estimated" })).toBe("around B1");
  expect(describeLevel({ level: "B1", source: "told" })).toBe("B1");
});
