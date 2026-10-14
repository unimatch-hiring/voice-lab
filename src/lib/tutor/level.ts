import { findMistakes } from "./mistakes";

/**
 * The learner's level: what they say it is, or what they sound like.
 *
 * Two sources and they are not equivalent. If the learner says "B1", that is the
 * answer — it is their own judgement about themselves and arguing with it on the
 * strength of four sentences would be both rude and wrong. Only when they will not
 * say does this estimate one, and then it says so.
 */

export type Level = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export interface Assessment {
  level: Level;
  /** `told` is the learner's own word for it; `estimated` is ours, from their speech. */
  source: "told" | "estimated";
}

/**
 * What a learner might call their level, in either language.
 *
 * Russian is included on purpose, and it is the one place where a Russian answer is
 * not drift: being asked your level in a language you are still learning is exactly
 * when you reach for your own. `lesson.ts` takes the answer and skips the steering
 * for that utterance.
 */
const NAMED: ReadonlyArray<[RegExp, Level]> = [
  [/\bupper[\s-]?intermediate\b/i, "B2"],
  [/\bpre[\s-]?intermediate\b/i, "A2"],
  [/\b(beginner|starter|basic)\b/i, "A1"],
  [/\belementary\b/i, "A2"],
  [/\bintermediate\b/i, "B1"],
  [/\b(advanced|fluent)\b/i, "C1"],
  [/\b(proficient|native|bilingual)\b/i, "C2"],
  // `\b` is ASCII-only in JavaScript, so a Cyrillic word never has a boundary before
  // it and none of these matched at all. Unicode lookarounds instead.
  [/(?<!\p{L})(начинающий|начальный|с нуля|нулевой)(?!\p{L})/iu, "A1"],
  [/(?<!\p{L})(базовый|элементарный|слабый)(?!\p{L})/iu, "A2"],
  [/(?<!\p{L})(средний|так себе|нормальный)(?!\p{L})/iu, "B1"],
  [/(?<!\p{L})(выше среднего|хороший)(?!\p{L})/iu, "B2"],
  [/(?<!\p{L})(продвинутый|свободный|высокий)(?!\p{L})/iu, "C1"],
  [/(?<!\p{L})(носитель|свободно владею)(?!\p{L})/iu, "C2"],
];

/**
 * Adjacent characters only. With a space allowed between them, "I rented a 2 bedroom
 * flat" and "can we do a 1 hour lesson" both read as a learner stating their level —
 * which pinned it, persisted it and never asked again. "B 1" spoken that way is the
 * price, and ASR writes it "B1" anyway.
 */
const CEFR = /\b([abc])([12])\b/i;

/**
 * The level in what the learner just said, or null if they did not say one.
 *
 * Named levels are tested before the CEFR codes because "upper intermediate" has to
 * beat "intermediate", and because a sentence can contain both.
 */
export function parseLevel(text: string): Level | null {
  for (const [pattern, level] of NAMED) {
    if (pattern.test(text)) return level;
  }
  const code = text.match(CEFR);
  if (code) return `${code[1].toUpperCase()}${code[2]}` as Level;
  return null;
}

/** Markers of a clause hanging off another one — the thing beginners do not build. */
const SUBORDINATE =
  /\b(because|although|though|however|which|whose|if|when|while|unless|until|whereas|so that|in order to|even though|that is why)\b/gi;

/** Each group is one way of placing an action in time; variety matters, not count. */
const TENSE_MARKERS: readonly RegExp[] = [
  /\b(will|'ll|going to)\b/i,
  /\b(would|could|should|might|must)\b/i,
  /\b(have|has|had)\s+\w+(ed|en|ne|me|ought|unk)\b/i,
  /\b(was|were|am|is|are)\s+\w+ing\b/i,
  /\b(did|was|were|had)\b/i,
];

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
}

/**
 * The band the learner sounds like, from the English they actually produced.
 *
 * Three outcomes and no more — A2, B1, C1 — because that is what a handful of spoken
 * sentences supports. A number like "B2" off four utterances would be a precision
 * nobody measured, and the announcement says "around" for the same reason.
 *
 * Measured on features that survive a transcript without punctuation: how much they
 * say, how varied it is, whether clauses hang off each other, how many ways of
 * placing an action in time appear, and how often a rule caught a mistake. Thresholds
 * are reasoned, not fitted — there is no corpus of graded learners here to fit to, and
 * `?record` fixtures of real lessons are what would replace them.
 *
 * The mistakes are counted from these samples rather than handed in. Passing the
 * lesson's running total divided it by three sentences, so a learner with any history
 * — anyone pressing "reset level" after a few corrections — was re-assessed downwards
 * before they opened their mouth.
 */
export function estimateLevel(samples: readonly string[]): Level {
  const all = samples.flatMap(words);
  if (all.length === 0) return "A2";

  const meanWords = all.length / samples.length;
  const variety = new Set(all).size / all.length;
  const clauses = samples.reduce((n, s) => n + (s.match(SUBORDINATE)?.length ?? 0), 0);
  const tenses = TENSE_MARKERS.filter((m) => samples.some((s) => m.test(s))).length;
  const errorRate = samples.filter((s) => findMistakes(s) !== null).length / samples.length;

  let score = 0;
  if (meanWords >= 8) score++;
  if (meanWords >= 14) score++;
  if (variety >= 0.62) score++;
  if (clauses / samples.length >= 0.5) score++;
  if (tenses >= 2) score++;
  if (tenses >= 4) score++;
  // Mistakes are the one signal that counts against, and only in quantity: a fluent
  // speaker still drops an article.
  if (errorRate >= 0.6) score -= 2;
  else if (errorRate >= 0.3) score--;

  if (score <= 1) return "A2";
  if (score <= 4) return "B1";
  return "C1";
}

/** How the agent is told to say it — "around B1" when we guessed, plainly when told. */
export function describeLevel(assessment: Assessment): string {
  return assessment.source === "told"
    ? assessment.level
    : `around ${assessment.level}`;
}
