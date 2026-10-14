import { expect, test } from "vitest";
import { findMistakes, labelOf, RULES } from "./mistakes";

/** The corrected sentence, or null when no rule recognised anything. */
const fix = (said: string) => findMistakes(said)?.fixed ?? null;

test("the sentence a learner should have said, not a fragment of it", () => {
  // Two rules fire here and the learner needs one sentence back, which is what the
  // board shows: `i like listen radio -> I like to listen to the radio`.
  const found = findMistakes("i like listen radio");

  expect(found?.fixed).toBe("I like to listen to the radio");
  expect(found?.said, "kept exactly as it was heard").toBe("i like listen radio");
  expect(found?.ruleIds).toEqual(["infinitive-to", "listen-to"]);
});

test("the mistakes Russian speakers actually make", () => {
  expect(fix("I want eat pizza")).toBe("I want to eat pizza");
  expect(fix("she have two cats")).toBe("She has two cats");
  expect(fix("he go to work every day")).toBe("He goes to work every day");
  expect(fix("I am agree with you")).toBe("I agree with you");
  // The contracted form has to keep the subject it is attached to; it used to come
  // back as "Iagree with you".
  expect(fix("I'm agree with you")).toBe("I agree with you");
  expect(fix("he's agree")).toBe("He agrees");
  expect(fix("he is agree with me")).toBe("He agrees with me");
  expect(fix("I need more informations")).toBe("I need more information");
  expect(fix("this is more better")).toBe("This is better");
  expect(fix("how it called")).toBe("What is it called");
  expect(fix("I feel myself tired")).toBe("I feel tired");
  expect(fix("I live here since 3 years")).toBe("I live here for 3 years");
  expect(fix("on the picture we see a dog")).toBe("In the picture we see a dog");
  expect(fix("let's make a photo")).toBe("Let's take a photo");
  expect(fix("I am interesting in music")).toBe("I am interested in music");
  expect(fix("it depends of the weather")).toBe("It depends on the weather");
  expect(fix("this is different of that")).toBe("This is different from that");
  expect(fix("I want watch TV")).toBe("I want to watch TV");
  expect(fix("he work in a bank")).toBe("He works in a bank");
  // The article is repaired whether or not the preposition was there.
  expect(fix("I like listen to radio")).toBe("I like to listen to the radio");
});

test("correct English is left alone", () => {
  // A rule that fires on a sentence that was fine is worse than a rule that misses:
  // it puts words in the learner's mouth and teaches them something false.
  const fine = [
    "I went to the cinema yesterday",
    "my sister likes to cook pasta",
    "he goes to school by bus",
    "she has two cats and a dog",
    "it is beautiful here in the autumn",
    "I agree with you completely",
    "I have lived here for three years",
    "we took a photo in the park",
    "I am interested in music",
    "it depends on the weather",
    "I listen to the radio every morning",
    "what is it called in English",
    // Found in review, all of them "corrected" into nonsense: an auxiliary or a modal
    // takes a bare infinitive, and several triggers take a noun.
    "did he go to school",
    "does she have a car",
    "can she come tomorrow",
    "let it go",
    "make it work",
    "I need help",
    "I start work at nine",
    "the car needs work",
    "my plans work well",
    "I like my watch",
    // Idiomatic English for being unwell, not a mistake.
    "I don't feel myself today",
    // Found in the sixth review. Capitalised, because real transcripts are: the
    // rule that rewrites correct English to itself returned lower case, so the
    // sentence differed from itself and was logged, counted and then drilled.
    "Listen to me please",
    "Listen to the radio with me",
    "I love live music",
    "I like live concerts in summer",
    "How do you call a taxi in London",
    "How do you call your dog",
  ];
  for (const sentence of fine) {
    expect(findMistakes(sentence), sentence).toBeNull();
  }
});

test("a rule that changes nothing is not a mistake", () => {
  // `listen-to` matches the correct form on purpose and rewrites it to itself. The
  // backstop is what makes that safe for every rule built that way, not just when
  // each one happens to preserve case.
  expect(findMistakes("Listen to me please")).toBeNull();
  expect(findMistakes("listen to the news")).toBeNull();
  // And it still repairs the broken forms, in either case.
  expect(fix("Listen radio with me")).toBe("Listen to the radio with me");
  expect(fix("i listen music every day")).toBe("I listen to music every day");
});

test("nothing recognised is null, which is not the same as nothing wrong", () => {
  // The honest limit: these rules cannot see "that is not how anyone says it".
  expect(findMistakes("I very like this film")).toBeNull();
  expect(findMistakes("")).toBeNull();
});

test("every rule has a label worth showing a learner", () => {
  for (const rule of RULES) {
    expect(labelOf(rule.id), rule.id).toBe(rule.label);
    expect(rule.label.length, rule.id).toBeGreaterThan(2);
  }
  expect(new Set(RULES.map((r) => r.id)).size, "ids are unique").toBe(RULES.length);
});
