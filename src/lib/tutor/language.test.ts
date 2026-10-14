import { expect, test } from "vitest";
import { tongueOf } from "./language";

test("an English sentence is English", () => {
  expect(tongueOf("I went to the cinema with my sister")).toBe("en");
});

test("a Russian sentence is Russian", () => {
  expect(tongueOf("давай лучше поговорим по-русски")).toBe("ru");
});

test("one Russian word inside an English sentence is not drift", () => {
  // The learner is short of a word, which calls for the English word rather than a
  // warning. Counted by character share instead, this sentence is 40% Cyrillic and
  // would have been judged the same as a sentence that is actually Russian.
  expect(tongueOf("yesterday I cooked борщ for my family")).toBe("en");
  expect(tongueOf("I like борщ")).toBe("en");
  expect(tongueOf("my мама is nice")).toBe("en");
});

test("half and half is neither", () => {
  expect(tongueOf("I think это is трудно")).toBe("mixed");
  // Mostly Russian with an English word left in is still the learner having
  // switched languages.
  expect(tongueOf("I think что это трудно")).toBe("ru");
});

test("nothing to judge is unknown, not English", () => {
  // An empty transcript must not count as the learner speaking English, or silence
  // would quietly clear a streak the learner never broke.
  for (const quiet of ["", "   ", "...", "123", "?!"]) {
    expect(tongueOf(quiet), quiet).toBe("unknown");
  }
});

test("a single Russian word is taken at face value", () => {
  expect(tongueOf("да")).toBe("ru");
  expect(tongueOf("конечно")).toBe("ru");
});

test("a single English word does not forgive a run of Russian", () => {
  // The asymmetry is the design: `en` wipes the whole ladder including an offer
  // already made, while a wrongly counted slip costs one gentle invitation that the
  // next English sentence undoes. So English has to be earned, and a reflex is not
  // a decision to speak English.
  for (const reflex of ["ok", "sure", "yes", "nice"]) {
    expect(tongueOf(reflex), reflex).toBe("unknown");
  }
  expect(tongueOf("yes, I did"), "two words is a sentence").toBe("en");
});

test("a Russian reply with one English word is not a return to English", () => {
  // Found in the second review: "one Russian word is a gap" without a majority test
  // was an escape hatch — a borrowed interjection every other turn held the ladder at
  // its bottom rung and the rule was never stated.
  expect(tongueOf("нет, sorry")).toBe("mixed");
  expect(tongueOf("да, please")).toBe("mixed");
  expect(tongueOf("хорошо ok"), "the reflex carries no weight").toBe("ru");
  expect(tongueOf("yes, спасибо")).toBe("mixed");
});

test("two Russian words among two English ones is not English", () => {
  expect(tongueOf("I купил новый phone")).toBe("mixed");
});

test("a contraction is one word, not two English ones", () => {
  // Found in the third review: splitting on the apostrophe counted "can't" as two
  // English words, and two of those dragged a plainly Russian sentence down to
  // `mixed` — where nothing is said about it at all.
  expect(tongueOf("I can't давай по-русски сейчас")).toBe("ru");
  expect(tongueOf("I don't know")).toBe("en");
});

test("a hyphenated Russian word is one word, not two", () => {
  // Found in the fourth review, the same bug in the other direction: "по-русски"
  // split into two Russian words, so an English question about one Russian word was
  // `mixed` and did not forgive the run it should have.
  expect(tongueOf("how do you say it по-русски")).toBe("en");
  expect(tongueOf("давай по-русски")).toBe("ru");
});

test("throat-clearing is not a language, in either script", () => {
  // `ru` would tell a learner who said "mm" that they spoke Russian; `en` would
  // forgive a run of Russian they never actually broke. Found in the fourth review:
  // hesitations written with dashes escaped both guards, and the commonest English
  // ones were absent — the costly direction, since `en` wipes the ladder.
  const sounds = ["а", "э", "мм", "ммм", "э-э", "а-а-а", "м-м", "э, а",
                  "um", "uh", "hmm", "oh", "eh", "huh", "mhm", "ок"];
  for (const sound of sounds) {
    expect(tongueOf(sound), sound).toBe("unknown");
  }
});
