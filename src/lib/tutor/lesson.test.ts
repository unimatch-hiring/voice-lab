import { expect, test } from "vitest";
import {
  INITIAL_LESSON,
  clearMistakes,
  forgiveSteering,
  resetLevel,
  rollback,
  step,
  type LessonState,
  type TutorAction,
} from "./lesson";

/** Feeds a conversation through the reducer and collects what the agent was told. */
function run(texts: string[], from: LessonState = INITIAL_LESSON) {
  let state = from;
  const actions: TutorAction[] = [];
  for (const text of texts) {
    const [next, produced] = step(state, { kind: "user-utterance", text });
    state = next;
    actions.push(...produced);
  }
  const steers = actions.filter(
    (a): a is Extract<TutorAction, { type: "steer-english" }> => a.type === "steer-english",
  );
  return { state, actions, steers, levels: steers.map((a) => a.level) };
}

test("English is left alone", () => {
  const { steers } = run(["I had eggs for breakfast", "my favourite film is Alien"]);
  expect(steers, "nothing to steer").toEqual([]);
});

test("Russian is steered back, harder the longer it goes on", () => {
  // The product promise: the lesson does not become a Russian conversation.
  const { levels } = run([
    "мне проще по-русски",
    "давай по-русски",
    "не хочу по-английски",
    "я же сказал, по-русски",
  ]);
  expect(levels).toEqual([1, 2, 2, 3]);
});

test("the ladder stops at offering, it never ends the lesson", () => {
  const { levels } = run(Array(8).fill("нет, по-русски"));
  expect(Math.max(...levels), "3 is the top rung").toBe(3);
});

test("the exit is offered once, then the reminders go back to steady", () => {
  // Found in review: the top rung used to repeat for every utterance after it, so a
  // learner was offered the exit on every single turn — the nagging rung 2 exists to
  // avoid. Saying nothing instead would leave the lesson running in Russian.
  const { levels } = run(Array(8).fill("нет, по-русски"));

  expect(levels).toEqual([1, 2, 2, 3, 2, 2, 2, 2]);
  expect(levels.filter((l) => l === 3), "offered once").toHaveLength(1);
});

test("a nudge that never reached the agent is repeated, not escalated past", () => {
  // The learner heard nothing, so stating the rule next would be answering a question
  // they were never asked.
  const [after, actions] = step(INITIAL_LESSON, {
    kind: "user-utterance",
    text: "давай по-русски",
  });
  expect(actions[0], "the invitation back").toMatchObject({ type: "steer-english", level: 1 });

  const lost = rollback(INITIAL_LESSON, after, actions[0]);
  const again = run(["и дальше по-русски"], lost);
  expect(again.levels, "the same rung again").toEqual([1]);
});

test("coming back to English forgives the run", () => {
  const first = run(["давай по-русски", "ну пожалуйста"]);
  expect(first.levels).toEqual([1, 2]);

  const back = run(["ok, sorry, what did you ask me"], first.state);
  expect(back.steers, "nothing to steer about an English reply").toEqual([]);

  // And the next slip starts over gently rather than resuming where it left off.
  expect(run(["а можно по-русски"], back.state).levels).toEqual([1]);
});

test("a learner who was offered the exit and came back is invited, not warned", () => {
  // Found in the third review: deleting the offer's reset left every test green. With
  // it latched, a learner who returned to English for the rest of the lesson and
  // drifted once an hour later got "the lesson only works in English" on that first
  // slip, and could never be offered the exit again.
  const offered = run(Array(4).fill("по-русски")).state;
  expect(offered.offered).toBe(true);

  const back = run(["sorry, I will try in English"], offered).state;
  expect(back.offered, "forgiven with the rest of the run").toBe(false);

  const relapse = run(Array(4).fill("опять по-русски"), back);
  expect(relapse.levels, "the whole ladder again, from the invitation").toEqual([1, 2, 2, 3]);
});

test("a vocabulary gap neither escalates nor forgives", () => {
  const drifted = run(["давай по-русски"]).state;
  // Genuinely half and half. "I cooked что-то simple yesterday" is not this case —
  // four English words carrying one Russian one is an English sentence, and it
  // forgives.
  const mixed = run(["I think это is трудно"], drifted);
  expect(mixed.steers, "not a warning").toEqual([]);
  // Not a pardon either: the next slip carries on up the ladder.
  expect(run(["и давай по-русски"], mixed.state).levels).toEqual([2]);
});

test("silence and throat-clearing do not pass for English", () => {
  const drifted = run(["давай по-русски"]).state;
  const quiet = run(["", "...", "мм", "а", "um"], drifted);
  expect(quiet.actions, "nothing was said to judge").toEqual([]);
  // The run is intact, so the next Russian sentence states the rule.
  expect(run(["и дальше по-русски"], quiet.state).levels).toEqual([2]);
});

test("every directive is marked so the agent does not read it aloud", () => {
  const { actions } = run(["по-русски", "по-русски", "по-русски", "по-русски"]);
  expect(actions).not.toHaveLength(0);
  for (const action of actions) {
    expect(action.text, action.text).toMatch(/^\[TUTOR DIRECTIVE\]/);
  }
});

test("a borrowed English word does not hold the ladder at its bottom rung", () => {
  // The learner answers in Russian every turn, with one English interjection in
  // between. Treating that as a return to English reset the streak each time, so the
  // rule was never stated and the exit was never offered.
  const { levels, state } = run([
    "давай по-русски",
    "нет, sorry",
    "давай по-русски",
    "да, please",
    "давай по-русски",
    "хорошо ok",
    "давай по-русски",
  ]);

  // The ladder climbs exactly as it would have without the interjections: the two
  // half-and-half replies are inert, and "хорошо ok" is a slip in its own right,
  // because a borrowed reflex carries no weight. Before the fix this read
  // [1, 1, 1, 1, 1] and never left the invitation.
  expect(levels).toEqual([1, 2, 2, 3, 2]);
  expect(state.offered).toBe(true);
});

const notes = (actions: TutorAction[]) =>
  actions.filter((a) => a.type === "note-mistake");
const rechecks = (actions: TutorAction[]) => actions.filter((a) => a.type === "recheck");

test("a mistake is recorded with the sentence the learner should have said", () => {
  const { state, actions } = run(["i like listen radio"]);

  expect(state.mistakes).toHaveLength(1);
  expect(state.mistakes[0]).toMatchObject({
    said: "i like listen radio",
    fixed: "I like to listen to the radio",
  });
  expect(notes(actions), "and the agent is told, so it can answer about it").toHaveLength(1);
  expect(notes(actions)[0].text).toContain("I like to listen to the radio");
});

test("the log outlives the conversation it was made in", () => {
  // This is the whole promise. A new lesson forgives the Russian, not the English.
  const lesson = run(["she have two cats", "давай по-русски"]).state;
  expect(lesson.mistakes).toHaveLength(1);
  expect(lesson.steersDelivered).toBe(1);

  const next = forgiveSteering(lesson);
  expect(next.mistakes, "still remembered").toHaveLength(1);
  expect(next.counts["third-person-s"]).toBe(1);
  expect(next.steersDelivered, "but the streak is not inherited").toBe(0);
});

test("counts are kept per rule, not per sentence", () => {
  // Pronoun subjects only: "my brother have" needs to know that "brother" is
  // singular, which is past what a rule can be sure of (see mistakes.ts).
  const { state } = run(["she have a cat", "he go home", "it have four legs"]);

  expect(state.counts["third-person-s"]).toBe(3);
  expect(state.mistakes).toHaveLength(3);
});

test("a mistake that settles in gets tested, once", () => {
  const first = run(["she have a cat", "he go home"]);
  expect(rechecks(first.actions), "twice is not a habit yet").toHaveLength(0);

  const third = run(["she have a dog"], first.state);
  expect(rechecks(third.actions), "the third time is").toHaveLength(1);
  expect(rechecks(third.actions)[0]).toMatchObject({ ruleId: "third-person-s" });

  const fourth = run(["he go to school"], third.state);
  expect(rechecks(fourth.actions), "and not again for the same rule").toHaveLength(0);
});

test("Russian is not checked for English mistakes", () => {
  // The detector would find nothing, but running it on Russian is how a tutor comes
  // to correct somebody's Russian grammar in English.
  const { state, actions } = run(["я хочу слушать радио"]);

  expect(state.mistakes).toEqual([]);
  expect(notes(actions)).toEqual([]);
});

test("a vocabulary gap is still checked for the English around it", () => {
  const { state } = run(["I like listen борщ recipes"]);
  expect(state.mistakes, "mixed is inert for steering, not for correcting").toHaveLength(1);
});

test("a lost directive must not lose the mistake it carried", () => {
  // The log is the one thing here a learner asks about later. Rolling the whole state
  // back on a dropped directive would silently throw it away.
  const [after, actions] = step(INITIAL_LESSON, {
    kind: "user-utterance",
    text: "she have two cats",
  });
  const lost = rollback(INITIAL_LESSON, after, actions[0]);

  expect(lost.mistakes, "still said, still recorded").toHaveLength(1);
  expect(lost.counts["third-person-s"]).toBe(1);
});

const levelActs = (actions: TutorAction[]) =>
  actions.filter(
    (a) => a.type === "ask-level" || a.type === "probe-level" || a.type === "level-set",
  );

test("the level is taken from the learner's own answer, in either language", () => {
  const told = run(["my level is intermediate"]);

  expect(told.state.level).toEqual({ level: "B1", source: "told" });
  expect(told.state.levelPhase).toBe("set");
  expect(levelActs(told.actions)[0]).toMatchObject({ type: "level-set" });

  // And in Russian, which is an answer rather than drift at this one moment.
  const inRussian = run(["я начинающий"]);
  expect(inRussian.state.level).toEqual({ level: "A1", source: "told" });
  expect(inRussian.levels, "no steering for answering the question").toEqual([]);
});

test("not answering is asked again, and only once", () => {
  const first = run(["I had eggs for breakfast"]);
  expect(levelActs(first.actions)[0]).toMatchObject({ type: "ask-level", again: true });

  const second = run(["the weather is nice today"], first.state);
  expect(levelActs(second.actions)[0], "stop asking, start listening").toMatchObject({
    type: "probe-level",
  });
  expect(second.state.levelPhase).toBe("probing");
});

test("a learner who will not say is told what they sound like", () => {
  let state = run(["I don't want to say"]).state;
  state = run(["why do you ask that"], state).state;
  expect(state.levelPhase).toBe("probing");

  const probing = run(
    [
      "I usually go to the office by bus because it is faster",
      "yesterday I cooked pasta with my sister and we watched a film",
      "I think I will travel to Italy next summer if I have money",
    ],
    state,
  );

  expect(probing.state.levelPhase).toBe("set");
  expect(probing.state.level).toEqual({ level: "B1", source: "estimated" });
  const announced = levelActs(probing.actions).at(-1);
  expect(announced).toMatchObject({ type: "level-set" });
  expect(announced?.text, "announced as a guess, not a score").toContain("around B1");
});

test("while the learner is in Russian, the lesson has one problem at a time", () => {
  // The level question waits where it is. Advancing it on a Russian utterance would
  // either skip the re-ask nobody heard, or pile two directives — come back to
  // English, and also what is your level — into one reply.
  let state = run(["I don't know"]).state;
  expect(state.levelPhase).toBe("asked-again");

  const russian = run(["мне сложно", "давай по-русски", "не буду"], state);
  expect(russian.state.levelPhase, "held, not advanced").toBe("asked-again");
  expect(levelActs(russian.actions), "the steering has the floor").toEqual([]);
  expect(russian.levels, "and it is steering").toEqual([1, 2, 2]);
});

test("Russian is never evidence of how well somebody speaks English", () => {
  let state = run(["I don't know"]).state;
  state = run(["why do you ask"], state).state;
  expect(state.levelPhase).toBe("probing");

  const probing = run(["мне сложно по-английски", "I live in Moscow with my family"], state);
  expect(probing.state.probes, "only the English sentence").toEqual([
    "I live in Moscow with my family",
  ]);
});

test("a set level is not asked about again", () => {
  const set = run(["I am B2"]).state;
  const after = run(["I went to the cinema", "it was good"], set);

  expect(levelActs(after.actions)).toEqual([]);
  expect(after.state.level).toEqual({ level: "B2", source: "told" });
});

test("a reset forgets the level and keeps the mistakes", () => {
  // This is what the button on the page does: ask me again, do not wipe my record.
  const lesson = run(["I am B2", "she have two cats"]).state;
  expect(lesson.mistakes).toHaveLength(1);

  const after = resetLevel(lesson);
  expect(after.level).toBeUndefined();
  expect(after.levelPhase, "the next thing that happens is being asked").toBe("asking");
  expect(after.mistakes, "the record is not what was reset").toHaveLength(1);

  // And the question really is asked again.
  const asked = run(["the weather is nice"], after);
  expect(levelActs(asked.actions)[0]).toMatchObject({ type: "ask-level" });
});

test("clearing the record keeps the level and lets rules be drilled again", () => {
  // The mirror of a level reset. `rechecked` has to go too: a learner starting a clean
  // record who then repeats a mistake three times should be tested on it again, not
  // silently passed over because an earlier record said it had been.
  const lesson = run([
    "I am B2",
    "she have a cat",
    "he go home",
    "it have four legs",
  ]).state;
  expect(lesson.mistakes).toHaveLength(3);
  expect(lesson.rechecked).toEqual(["third-person-s"]);

  const cleared = clearMistakes(lesson);
  expect(cleared.mistakes).toEqual([]);
  expect(cleared.counts).toEqual({});
  expect(cleared.rechecked).toEqual([]);
  expect(cleared.level, "the level is not what was cleared").toEqual({
    level: "B2",
    source: "told",
  });

  // Counting starts over, and the third repeat is drilled again.
  const again = run(["she have a dog", "he go there", "it have a tail"], cleared);
  expect(again.state.counts["third-person-s"]).toBe(3);
  expect(rechecks(again.actions)).toHaveLength(1);
});
