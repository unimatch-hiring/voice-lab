import { DIRECTIVE_MARKER } from "../persona";
import { tongueOf } from "./language";
import { describeLevel, estimateLevel, parseLevel, type Assessment } from "./level";
import { findMistakes, labelOf, type Correction } from "./mistakes";

/**
 * The lesson's state machine: what the tutor knows, and what it wants the agent to
 * do about it.
 *
 * A pure reducer, because the one thing this feature promises — the conversation
 * stays in English — must not depend on a model choosing to remember seven
 * instructions at once. The prompt carries the manner; the counters, the thresholds
 * and the decision to escalate live here, where a test can drive them. Full
 * reasoning: docs/tutor.md
 */

/**
 * Deliberately only what drives a decision. Counters that nothing reads look like
 * the lesson's record and are not one — a streak nobody consults cannot be wrong,
 * so it cannot be tested either. The observable record of a lesson is the sequence
 * of directives it produced.
 */
export interface LessonState {
  /**
   * Directives the agent was actually handed during this run of Russian. The rung is
   * derived from this rather than from how many Russian sentences there were: a nudge
   * that never left the page is a rung the learner never heard, and climbing past it
   * would state the rule to someone who was never invited back.
   */
  steersDelivered: number;
  /** The exit has been offered. Made once per run, not on every sentence after it. */
  offered: boolean;
  /**
   * What the learner got wrong, oldest first. Outlives a conversation on purpose:
   * forgiving a run of Russian is kindness, forgetting the mistakes would be the
   * product failing at the thing it says it does.
   */
  mistakes: readonly Correction[];
  /** Times each rule has fired, for "that is the fourth time". */
  counts: Readonly<Record<string, number>>;
  /** Rules already drilled, so the same one is not tested over and over. */
  rechecked: readonly string[];
  /**
   * Where the level stands. `asking` is also what a reset returns to, which is the
   * whole of what "reset" means here: the next thing the agent does is ask again.
   */
  levelPhase: "asking" | "asked-again" | "probing" | "set";
  /** Known once the learner says so, or once there was enough English to judge. */
  level?: Assessment;
  /** English the learner produced while being drawn out, for the estimate. */
  probes: readonly string[];
}

export const INITIAL_LESSON: LessonState = {
  steersDelivered: 0,
  offered: false,
  mistakes: [],
  counts: {},
  rechecked: [],
  levelPhase: "asking",
  probes: [],
};

export type TutorInput = { kind: "user-utterance"; text: string };

/**
 * `level` is the assertion; `text` is only the wording handed to the agent. Tests
 * assert the level, so the phrasing can be reworded without a test going red over
 * a sentence nobody promised.
 */
export type TutorAction =
  | { type: "steer-english"; level: 1 | 2 | 3; text: string }
  | { type: "ask-level"; again: boolean; text: string }
  | { type: "probe-level"; text: string }
  | { type: "level-set"; assessment: Assessment; text: string }
  | {
      type: "note-mistake";
      correction: Correction;
      /** Mistakes in the log once this one is in it. Counted here so that whatever
       * displays it cannot drift from the reducer's own tally. */
      total: number;
      text: string;
    }
  | { type: "recheck"; ruleId: string; text: string };

/**
 * Where the ladder steps, counted in nudges the learner has actually been given.
 * The first gets a warm invitation back, the second gets the rule stated, and only
 * a learner who keeps going after that is offered the exit — the third is
 * deliberately given another chance at rung 2 rather than escalated, because
 * asking twice is a nudge and asking every time is nagging.
 *
 * Chosen, not measured, and these two numbers are the whole policy: raise OFFER_AT
 * to be more patient, lower it to be stricter.
 */
const FIRM_AT = 2;
const OFFER_AT = 4;

/**
 * Times one mistake has to recur before the agent is asked to test it.
 *
 * Three, not two: a learner who says a thing wrong twice may simply have said it
 * twice, and being drilled on everything is the correcting equivalent of nagging.
 */
const RECHECK_AT = 3;

/**
 * Utterances of English to hear before guessing a level.
 *
 * Three, which is few — but a learner who has twice declined to say their level is not
 * going to sit through an exam, and the alternative to a rough guess is no level at
 * all. The guess is announced as "around B1" for exactly this reason.
 */
const PROBE_UTTERANCES = 3;

/**
 * Directives reach the agent as contextual updates — context it acts on, not a turn
 * it answers and not a line it reads out.
 */
export function steerDirective(level: 1 | 2 | 3): string {
  if (level === 1) {
    return `${DIRECTIVE_MARKER} The learner just spoke Russian. Answer in English only, warmly, and invite them to try the same thing in English. Do not translate it for them.`;
  }
  if (level === 2) {
    return `${DIRECTIVE_MARKER} The learner is speaking Russian again. Stay in English, say in one short sentence that the lesson only works in English, and give them an easy question they can answer in three or four words.`;
  }
  return `${DIRECTIVE_MARKER} The learner keeps speaking Russian. In English, offer to stop the lesson for today and say they are welcome back whenever they want to practise in English. Do not hang up — wait for their answer, and carry on in English if they choose to stay.`;
}

/** The note that keeps the record in the agent's context, so "remind me" needs no
 * intent detection: the log is simply always there to answer from. */
function mistakeNote(c: Correction, times: number): string {
  const labels = c.ruleIds.map(labelOf).join(", ");
  return `${DIRECTIVE_MARKER} Noted for the record: the learner said "${c.said}" where English wants "${c.fixed}" (${labels}; ${times} so far). Correct it in passing and keep the conversation going. Never read this note out. If they ask what they keep getting wrong, answer from these notes and nothing else.`;
}

function recheckNote(c: Correction, ruleId: string, times: number): string {
  return `${DIRECTIVE_MARKER} The learner has got "${labelOf(ruleId)}" wrong ${times} times, most recently "${c.said}" instead of "${c.fixed}". Work a question into your next reply that can only be answered with the right form, and say what was good about it if they get it right. Do not announce that you are testing them.`;
}

/**
 * Which rung the next nudge belongs on.
 *
 * Once the exit has been offered, further slips drop back to steady reminders. The
 * learner has heard the offer; repeating it every turn is the nagging the rung-2
 * rule above exists to avoid, and the alternative — saying nothing — would leave
 * the lesson to carry on in Russian unopposed.
 */
function levelFor(nudge: number, offered: boolean): 1 | 2 | 3 {
  if (offered) return 2;
  if (nudge >= OFFER_AT) return 3;
  if (nudge >= FIRM_AT) return 2;
  return 1;
}

export function askLevelDirective(again: boolean): string {
  return again
    ? `${DIRECTIVE_MARKER} The learner has not said what their level of English is. Ask once more, in the simplest words you can, and give them examples to pick from — beginner, intermediate, advanced.`
    : `${DIRECTIVE_MARKER} Ask the learner what their level of English is, in one short question.`;
}

export function resetLevelDirective(): string {
  return `${DIRECTIVE_MARKER} The learner has cleared their level. Forget any previous level and ask what their level of English is now, in one short question.`;
}

function probeNote(): string {
  return `${DIRECTIVE_MARKER} The learner will not say what their level is, so stop asking. Say you will work it out as you go, then ask two or three ordinary questions about everyday things and let them talk.`;
}

function levelSetNote(assessment: Assessment): string {
  return assessment.source === "told"
    ? `${DIRECTIVE_MARKER} The learner says their level is ${assessment.level}. Say it back so they know you heard, pitch everything there from now on, and do not ask again.`
    : `${DIRECTIVE_MARKER} From how they speak, this learner sounds ${describeLevel(assessment)}. Tell them that in one sentence, say briefly what gave it away, and carry on at that level. Do not call it a test or a score.`;
}

/**
 * One utterance in, the next state and whatever the agent should be told out.
 *
 * The state returned assumes the directives reach the agent. They are sent by
 * `supervisor.ts`, which reports a failure back through `rollback()`.
 *
 * Only Russian advances the ladder. `mixed` leaves the streak untouched on
 * purpose — reaching for one Russian word inside an English sentence is a gap to
 * fill, not drift to correct — and `unknown` is nothing having been said.
 */
export function step(state: LessonState, input: TutorInput): [LessonState, TutorAction[]] {
  const tongue = tongueOf(input.text);

  // The level question first, and before the language check. Being asked your level in
  // a language you are still learning is the one moment where reaching for Russian is
  // an answer rather than drift, so an answer is taken in either language and the
  // steering sits this utterance out.
  if (state.levelPhase !== "set") {
    const told = parseLevel(input.text);
    if (told) {
      const assessment: Assessment = { level: told, source: "told" };
      return [
        { ...state, levelPhase: "set", level: assessment },
        [{ type: "level-set", assessment, text: levelSetNote(assessment) }],
      ];
    }
  }

  if (tongue === "ru") {
    const nudge = state.steersDelivered + 1;
    const level = levelFor(nudge, state.offered);
    return [
      { ...state, steersDelivered: nudge, offered: state.offered || level === 3 },
      [{ type: "steer-english", level, text: steerDirective(level) }],
    ];
  }

  // Nothing judgeable was said, so there is no English in it to check either.
  if (tongue === "unknown") return [state, []];

  // A return to English forgives the run outright, the offer included: a learner who
  // came back and later drifts again is invited back warmly rather than met with the
  // rule they earned an hour ago. A vocabulary gap forgives nothing — but the English
  // around the gap is still worth checking, so both land here.
  const base = tongue === "en" ? forgiveSteering(state) : state;

  const [withLevel, levelActions] = advanceLevel(base, input.text, tongue);

  const correction = findMistakes(input.text);
  if (!correction) return [withLevel, levelActions];

  const base2 = withLevel;

  const counts = { ...base2.counts };
  for (const id of correction.ruleIds) counts[id] = (counts[id] ?? 0) + 1;
  const times = Math.max(...correction.ruleIds.map((id) => counts[id]));

  const actions: TutorAction[] = [
    ...levelActions,
    {
      type: "note-mistake",
      correction,
      total: base2.mistakes.length + 1,
      text: mistakeNote(correction, times),
    },
  ];

  // One recheck at a time, and only for a mistake that has actually settled in.
  const due = correction.ruleIds.find(
    (id) => counts[id] >= RECHECK_AT && !base2.rechecked.includes(id),
  );
  const rechecked = due ? [...base2.rechecked, due] : base2.rechecked;
  if (due) {
    actions.push({
      type: "recheck",
      ruleId: due,
      text: recheckNote(correction, due, counts[due]),
    });
  }

  return [
    { ...base2, mistakes: [...base2.mistakes, correction], counts, rechecked },
    actions,
  ];
}

/**
 * Moves the level question along by one utterance.
 *
 * "They did not answer" is decided here rather than guessed by the agent: anything
 * judgeable that was not a level counts as not answering, and two of those is enough
 * to stop asking and start listening instead. Only English counts as a probe — a
 * Russian sentence says nothing about how well somebody speaks English.
 */
function advanceLevel(
  state: LessonState,
  text: string,
  tongue: "en" | "mixed",
): [LessonState, TutorAction[]] {
  if (state.levelPhase === "set") return [state, []];

  if (state.levelPhase === "asking") {
    return [
      { ...state, levelPhase: "asked-again" },
      [{ type: "ask-level", again: true, text: askLevelDirective(true) }],
    ];
  }

  if (state.levelPhase === "asked-again") {
    // The utterance that declined to answer is not kept as a sample. It is English
    // the learner produced, but "why do you ask" is short and evasive by nature, and
    // three of those would drag the estimate below what they can actually do. The
    // samples are the answers to the questions the agent is about to ask.
    return [
      { ...state, levelPhase: "probing" },
      [{ type: "probe-level", text: probeNote() }],
    ];
  }

  const probes = tongue === "en" ? [...state.probes, text] : state.probes;
  if (probes.length < PROBE_UTTERANCES) return [{ ...state, probes }, []];

  const assessment: Assessment = {
    level: estimateLevel(probes),
    source: "estimated",
  };
  return [
    { ...state, levelPhase: "set", level: assessment, probes },
    [{ type: "level-set", assessment, text: levelSetNote(assessment) }],
  ];
}

/**
 * Forgets the level and asks again, which is the whole of what a reset is for. The
 * mistakes are kept: the learner asked to be re-assessed, not to be forgotten.
 */
export function resetLevel(state: LessonState): LessonState {
  return { ...state, levelPhase: "asking", level: undefined, probes: [] };
}

/**
 * Wipes the record and keeps the level — the mirror of `resetLevel`.
 *
 * `rechecked` goes with it. The marks say which rules have already been drilled, and
 * a learner starting a clean record who then repeats a mistake three times should be
 * tested on it again rather than silently passed over.
 */
export function clearMistakes(state: LessonState): LessonState {
  return { ...state, mistakes: [], counts: {}, rechecked: [] };
}

/**
 * Clears the steering and keeps everything else.
 *
 * Used both when the learner returns to English and when a new conversation starts:
 * a fresh lesson does not inherit the last one's streak, but it does inherit what the
 * learner gets wrong.
 */
export function forgiveSteering(state: LessonState): LessonState {
  return { ...state, steersDelivered: 0, offered: false };
}

/**
 * The state to keep when one directive did not reach the agent.
 *
 * Rolled back per action, because what is lost differs by action and the wrong
 * rollback is its own bug:
 *
 * - a lost **steer** must not climb the rung — the next slip repeats the nudge the
 *   learner never heard instead of stating a rule they were never invited past;
 * - a lost **recheck** must not mark its rule as drilled, or the learner is tested
 *   once, silently, with a question they never heard, and never again;
 * - a lost **note** rolls back nothing at all. The mistake was still made, and the
 *   log is the one thing here a learner asks about later.
 *
 * The earlier version rolled the steering back whatever was lost, which un-forgave a
 * return to English: on an English sentence the steering was cleared by
 * `forgiveSteering`, not earned by a directive, so restoring it put the learner back
 * on a rung they had climbed off.
 */
export function rollback(
  before: LessonState,
  after: LessonState,
  action: TutorAction,
): LessonState {
  if (action.type === "steer-english") {
    return {
      ...after,
      steersDelivered: before.steersDelivered,
      offered: before.offered,
    };
  }
  if (action.type === "recheck") {
    return { ...after, rechecked: after.rechecked.filter((id) => id !== action.ruleId) };
  }
  if (action.type !== "note-mistake") {
    // A level question, a probe or an announcement nobody heard leaves the level
    // exactly where it was. Otherwise a lost re-ask meant the learner was asked once
    // and then told "you will not say, so I will stop asking", and a lost
    // announcement stored a level, drew it on the page and never told them.
    return {
      ...after,
      levelPhase: before.levelPhase,
      level: before.level,
      probes: before.probes,
    };
  }
  return after;
}
