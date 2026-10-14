import { expect, test } from "vitest";
import { EventBus } from "../events";
import type { PipelineEvent } from "../types";
import { Tutor, type TutorChannel } from "./supervisor";

function harness({ deliver = true }: { deliver?: boolean } = {}) {
  const bus = new EventBus();
  const sent: string[] = [];
  const live = { deliver };
  const channel: TutorChannel = {
    sendContext: (text) => {
      sent.push(text);
      return live.deliver;
    },
  };
  const tutor = new Tutor(bus, channel);
  const detach = tutor.attach();
  const said = (text: string) =>
    bus.emit({ type: "stt-result", result: { text, words: [] } });
  return { bus, sent, tutor, detach, said, live };
}

test("a learner drifting into Russian is steered through the live conversation", () => {
  const { sent, said } = harness();

  said("I like cooking on weekends");
  expect(
    sent.filter((t) => /Russian/.test(t)),
    "English needs no steering",
  ).toEqual([]);

  said("дальше давай по-русски");
  // Two directives by now: the level question the English sentence did not answer,
  // and the steering this one earned.
  const steering = sent.filter((t) => /spoke Russian/.test(t));
  expect(steering).toHaveLength(1);
  expect(steering[0]).toMatch(/^\[TUTOR DIRECTIVE\]/);
  expect(steering[0]).toMatch(/English/);
});

test("a new lesson asks its level through the live channel before it starts probing", () => {
  const { sent, said, tutor } = harness();

  tutor.begin();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/Ask the learner what their level/i);

  said("I would rather not say");
  expect(tutor.lesson.levelPhase).toBe("probing");
  expect(sent[1]).toMatch(/stop asking/i);
});

test("the agent's own English is not judged as the learner's", () => {
  // `agent-reply` carries what the tutor said. Counting it would clear the streak
  // the learner had just set, on every single turn.
  const { sent, said, bus, tutor } = harness();

  said("не хочу по-английски");
  bus.emit({ type: "agent-reply", text: "No problem — tell me in English?", at: 0 });
  said("по-русски проще");

  expect(sent, "two slips in a row, two directives").toHaveLength(2);
  expect(sent[1], "the second states the rule").not.toBe(sent[0]);
});

test("a new lesson does not inherit the last learner's streak", () => {
  const { said, tutor, sent } = harness();

  said("по-русски давай");
  said("по-русски");
  tutor.reset();
  said("опять по-русски");

  expect(sent).toHaveLength(3);
  expect(sent[2], "back to the gentle rung").toBe(sent[0]);
});

test("detaching stops the steering", () => {
  const { sent, said, detach } = harness();
  detach();
  said("давай по-русски");
  expect(sent).toEqual([]);
});

test("a dropped directive leaves the learner on the rung they never heard", () => {
  // There is no live conversation to hand it to — mid-reconnect, or the socket died
  // between the transcript and the directive.
  const { sent, said, tutor, live } = harness({ deliver: false });

  said("давай по-русски");
  expect(sent, "attempted").toHaveLength(1);
  expect(tutor.lesson.steersDelivered, "nothing landed").toBe(0);

  live.deliver = true;
  said("и дальше по-русски");
  expect(sent[1], "the invitation back, not the rule").toBe(sent[0]);
  expect(tutor.lesson.steersDelivered, "now it landed").toBe(1);
});

test("a mistake reaches the screen as an event, not by the scene knowing the tutor", () => {
  const { bus, said, sent } = harness();
  const seen: PipelineEvent[] = [];
  bus.on((e) => {
    if (e.type === "mistake") seen.push(e);
  });

  said("i like listen radio");

  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    type: "mistake",
    said: "i like listen radio",
    fixed: "I like to listen to the radio",
    total: 1,
  });
  // Labels, not rule ids: the board shows them to a learner and needs nothing from
  // the tutor to do it.
  expect((seen[0] as { labels: string[] }).labels).toEqual(["to + infinitive", "listen to"]);
  expect(sent[0], "and the agent is told, so it can answer about it later").toMatch(
    /^\[TUTOR DIRECTIVE\]/,
  );
});

test("the counter follows the log, not the events it happened to see", () => {
  const { said, bus } = harness();
  const totals: number[] = [];
  bus.on((e) => {
    if (e.type === "mistake") totals.push(e.total);
  });

  said("she have two cats");
  said("I went home");
  said("he go to work");

  expect(totals).toEqual([1, 2]);
});

test("a new conversation keeps what the learner gets wrong", () => {
  const { said, tutor } = harness();

  said("she have two cats");
  tutor.reset();

  expect(tutor.lesson.mistakes, "forgive the Russian, remember the English").toHaveLength(1);
  expect(tutor.lesson.steersDelivered).toBe(0);
});

test("a lost mistake note does not un-forgive a return to English", () => {
  // Found in review: the rollback restored the steering whatever had been lost. On an
  // English sentence the steering was cleared by returning to English, not earned by a
  // directive — so a dropped note put the learner back on a rung they had climbed off,
  // and their next slip stated the rule instead of inviting them back.
  const { said, tutor, live, sent } = harness();

  said("давай по-русски");
  said("нет, по-русски");
  expect(tutor.lesson.steersDelivered).toBe(2);

  live.deliver = false;
  said("she have two cats");
  expect(tutor.lesson.mistakes, "the mistake is kept either way").toHaveLength(1);
  expect(tutor.lesson.steersDelivered, "and the return is still forgiven").toBe(0);

  live.deliver = true;
  said("опять по-русски");
  expect(sent[sent.length - 1], "the gentle invitation, not the rule").toBe(sent[0]);
});

test("a recheck nobody heard is not marked as done", () => {
  // Otherwise the learner is tested once, silently, with a question that never
  // arrived — and that rule can never be drilled again.
  const { said, tutor, live } = harness();

  said("she have a cat");
  said("he go home");
  live.deliver = false;
  said("it have four legs");
  expect(tutor.lesson.rechecked, "the drill went nowhere").toEqual([]);

  live.deliver = true;
  said("she have a dog");
  expect(tutor.lesson.rechecked, "so it is still owed").toEqual(["third-person-s"]);
});

test("a level from a previous visit is picked up without asking again", () => {
  const { tutor, sent } = harness();

  tutor.restore({
    level: { level: "B2", source: "told" },
    mistakes: [],
    counts: {},
    rechecked: [],
  });

  expect(tutor.lesson.levelPhase).toBe("set");
  expect(sent, "nothing to tell the agent until it is in a session").toEqual([]);
});

test("a restored lesson redraws the mistakes it remembers", () => {
  const { bus, tutor } = harness();
  const seen: { said: string; total: number }[] = [];
  bus.on((e) => {
    if (e.type === "mistake") seen.push({ said: e.said, total: e.total });
  });

  tutor.restore({
    mistakes: [
      { said: "she have two cats", fixed: "She has two cats", ruleIds: ["third-person-s"] },
      { said: "i like listen radio", fixed: "I like to listen to the radio", ruleIds: ["listen-to"] },
    ],
    counts: { "third-person-s": 1, "listen-to": 1 },
    rechecked: [],
  });

  // The board draws from these, so the count has to continue rather than restart.
  expect(seen).toEqual([
    { said: "she have two cats", total: 1 },
    { said: "i like listen radio", total: 2 },
  ]);
});

test("resetting the level asks again and keeps the record", () => {
  const { said, tutor, sent, bus } = harness();
  const announced: (string | null)[] = [];
  bus.on((e) => {
    if (e.type === "level") announced.push(e.level);
  });

  said("I am B2");
  said("she have two cats");
  expect(tutor.lesson.level).toEqual({ level: "B2", source: "told" });

  tutor.resetLevel();

  expect(tutor.lesson.level, "forgotten").toBeUndefined();
  expect(tutor.lesson.mistakes, "but not the record").toHaveLength(1);
  expect(sent.at(-1), "and the agent is told to ask again now").toMatch(/cleared their level/);
  expect(announced.at(-1), "the page shows it as unset").toBeNull();
});

test("what is worth surviving a reload is handed over to be saved", () => {
  const saved: unknown[] = [];
  const bus = new EventBus();
  const tutor = new Tutor(bus, { sendContext: () => true }, (lesson) => saved.push(lesson));
  tutor.attach();
  const said = (text: string) =>
    bus.emit({ type: "stt-result", result: { text, words: [] } });

  said("I am B1");
  said("she have two cats");
  said("I went to the shop");

  expect(saved, "the level and the mistake, not the plain sentence").toHaveLength(2);
  expect(saved.at(-1)).toMatchObject({
    level: { level: "B1", source: "told" },
    counts: { "third-person-s": 1 },
  });
});

test("a level question nobody heard is asked again, not escalated past", () => {
  // Found in the sixth review: the phase advanced whatever happened to the directive,
  // so a lost re-ask left the learner asked once and then told "you will not say, so
  // I will stop asking".
  const { said, tutor, live, sent } = harness({ deliver: false });

  said("I had eggs for breakfast");
  expect(tutor.lesson.levelPhase, "the question went nowhere").toBe("asking");

  live.deliver = true;
  said("the weather is nice today");
  expect(tutor.lesson.levelPhase).toBe("asked-again");
  expect(sent.at(-1), "and it is the question, not the giving up").toMatch(
    /what their level of English is/,
  );
});

test("a level announcement nobody heard does not silently set the level", () => {
  // Otherwise the page shows a level, the store keeps it, and the learner was never
  // told what it was.
  const { said, tutor, live } = harness({ deliver: false });

  said("my level is intermediate");

  expect(tutor.lesson.level, "nothing was announced, so nothing is settled").toBeUndefined();
  expect(tutor.lesson.levelPhase).toBe("asking");

  live.deliver = true;
  said("I am B1");
  expect(tutor.lesson.level).toEqual({ level: "B1", source: "told" });
});

test("clearing the record wipes it, saves it, and tells the agent it is gone", () => {
  // The directive is the point: the notes are already in the agent's context and
  // cannot be taken back out, so without it the learner clears the board and is then
  // told they keep making a mistake that is no longer written anywhere.
  const saved: unknown[] = [];
  const bus = new EventBus();
  const sent: string[] = [];
  const tutor = new Tutor(
    bus,
    {
      sendContext: (text) => {
        sent.push(text);
        return true;
      },
    },
    (lesson) => saved.push(lesson),
  );
  tutor.attach();
  const seen: string[] = [];
  bus.on((e) => {
    if (e.type === "mistakes-cleared") seen.push("cleared");
  });
  bus.emit({ type: "stt-result", result: { text: "she have two cats", words: [] } });

  tutor.clearMistakes();

  expect(tutor.lesson.mistakes).toEqual([]);
  expect(seen, "the board is told to empty itself").toEqual(["cleared"]);
  expect(sent.at(-1)).toMatch(/cleared their record/);
  expect(saved.at(-1), "and the wipe is written down").toMatchObject({
    mistakes: [],
    counts: {},
  });
});

test("clearing an empty record does nothing at all", () => {
  // Otherwise a button press on an empty board spends a directive telling the agent a
  // record was wiped, and makes the page flicker for no reason.
  const { tutor, sent, bus } = harness();
  const seen: string[] = [];
  bus.on((e) => {
    if (e.type === "mistakes-cleared") seen.push("cleared");
  });

  tutor.clearMistakes();

  expect(sent).toEqual([]);
  expect(seen).toEqual([]);
});
