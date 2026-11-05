import { CLUB_SOURCES, type ClubSource } from "./club";
import { compileFact, statesFact } from "./factMatch";

export type ClaimSegment =
  | { kind: "plain"; text: string }
  | { kind: "assumption"; text: string }
  | { kind: "unverified"; text: string }
  | { kind: "fact"; source: string; text: string };

/** How the agent flags a guess out loud. The prompt teaches these and the parser finds them. */
export const ASSUMPTION_LEADS = {
  ru: ["Думаю", "Я думаю", "Предполагаю", "Мне кажется", "Скорее всего", "Наверное", "Вероятно", "Возможно", "По-моему"],
  en: ["I think", "I assume", "I guess", "My guess is", "Probably", "Perhaps", "Maybe"],
};

/** Other ways a speaker flags a guess: recognised, but not worth teaching in the prompt. */
const ASSUMPTION_ALSO = [
  "Полагаю", "Предположу", "Могу предположить", "Кажется", "Видимо", "Похоже", "Пожалуй",
  "Судя по всему", "Может быть", "Мне думается", "Это мое предположение", "Это моё предположение",
  "Моя догадка", "I believe", "I suppose", "I'd guess", "I would guess", "It seems", "It looks like",
  "Likely", "Possibly", "I imagine",
];

/** Unambiguous inside a sentence too; "похоже на" and "it seems" are not on this list. */
const HEDGE = new RegExp(
  `(?<![\\p{L}\\p{N}-])(?:думаю|полагаю|наверное|вероятно|возможно|кажется|пожалуй|видимо|скорее\\s+всего|по-моему` +
    `|i\\s+think|i\\s+believe|i\\s+guess|i\\s+suppose|probably|perhaps|maybe)(?![\\p{L}\\p{N}-])`,
  "iu",
);

/** How the agent cites a source out loud. */
export function factLabels(source: ClubSource): { ru: string; en: string } {
  return { ru: `По ${source.ru},`, en: `According to the ${source.en},` };
}

/** "price-list" and "price list" name one source. */
const sourceKey = (name: string) => name.replace(/[\s-]+/g, " ").toLowerCase();

const SOURCE_BY_NAME = new Map(
  CLUB_SOURCES.flatMap((s) =>
    [s.ru, s.en, ...s.short.ru, ...s.short.en, ...s.in, ...s.of].map((name) => [sourceKey(name), s.id] as const),
  ),
);

const DIRECTORY = new Map(
  CLUB_SOURCES.map((s) => [
    s.id,
    [...s.facts.flatMap((f) => [f.ru, f.en]), ...s.also].map(compileFact),
  ]),
);

// Never inside a run of spaces: a leftover blank piece would count as a sentence. A lower
// case continuation is a pause or an abbreviation ("Думаю... да", "5 p.m. tomorrow").
const SENTENCE_BREAK = /(?<=[.!?…][*_»")]*\s+)(?!\s)(?!\p{Ll})|(?<=\n\s*)(?!\s)/u;
const IS_QUESTION = /\?[^\p{L}\p{N}]*$/u;

// Longest first, or "расписанию" would claim the start of "расписанию занятий".
const words = (phrases: string[]) =>
  [...phrases]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[\s-]+/g, "[\\s-]+"))
    .join("|");
const NAMES_RU = words(CLUB_SOURCES.flatMap((s) => [s.ru, ...s.short.ru]));
const NAMES_IN = words(CLUB_SOURCES.flatMap((s) => s.in));
const NAMES_EN = words(CLUB_SOURCES.flatMap((s) => [s.en, ...s.short.en]));
const NAMES_OF = words(CLUB_SOURCES.flatMap((s) => s.of));
const LEADS = words([...ASSUMPTION_LEADS.ru, ...ASSUMPTION_LEADS.en, ...ASSUMPTION_ALSO]);
const SAID = "указано|написано|сказано";

// In Russian only known sources count: "По понедельникам" opens a sentence just as "По блогу"
// does, so an unknown one cannot be told from ordinary speech. "According to" always cites.
const LEAD = new RegExp(
  `(?<=^\\s*|[.!?…][*_»")]*\\s*|\\n\\s*)(?<![*_])(?:[-•*]\\s+)?[*_]*` +
    `(?:(?:да|конечно|разумеется|хорошо|отлично|верно|итак|смотрите|yes|sure|of\\s+course|right|okay|ok|absolutely|certainly|great)\\s*,\\s*)?` +
    `(?:(?:по|согласно|судя\\s+по)\\s+(?:нашему\\s+)?(${NAMES_RU})` +
    `|(?:как\\s+(?:${SAID})\\s+)?в\\s+(?:нашем\\s+)?(${NAMES_IN})(?:\\s+(?:${SAID})(?:\\s*,?\\s*что)?)?` +
    `|(?:по\\s+данным|из|исходя\\s+из)\\s+(?:нашего\\s+)?(${NAMES_OF})` +
    `|according\\s+to\\s+(?:the\\s+|our\\s+)?(${NAMES_EN}|[^,:.!?\\n]{1,40}?)` +
    `|(?:as\\s+per|per|based\\s+on)\\s+(?:the\\s+|our\\s+)?(${NAMES_EN})` +
    `|(?:in|on|from)\\s+(?:the|our)\\s+(${NAMES_EN})` +
    `|(?:the|our)\\s+(${NAMES_EN})\\s+(?:says|shows|lists)(?:\\s+that)?` +
    `|(${LEADS}))` +
    `(?![\\p{L}\\p{N}])[*_]*(?:\\s*[,:—–]|\\s*-(?=\\s))?[*_]*\\s*`,
  "giu",
);

/**
 * Splits a reply by the phrases the prompt teaches. A phrase answers for its own sentence;
 * a cited one must state an entry of that source's directory (see factMatch.ts). What follows
 * is ordinary speech, like the bridge back to the club: a later sentence becomes a fact only
 * if it states an entry of the same source, and otherwise stays plain, even with a wrong figure.
 */
export function parseClaims(reply: string): ClaimSegment[] {
  const matches = [...reply.matchAll(LEAD)];

  const segments: ClaimSegment[] = [];
  const add = (segment: ClaimSegment) => {
    const last = segments[segments.length - 1];
    const sameFact =
      segment.kind === "fact" && last?.kind === "fact" && segment.source === last.source;
    if (sameFact || (segment.kind === "plain" && last?.kind === "plain")) last.text += segment.text;
    else segments.push(segment);
  };
  // Speech with no opening phrase can still hedge: "Это, думаю, выгодно."
  const addPlain = (text: string) => {
    for (const sentence of text.split(SENTENCE_BREAK)) {
      const hedged = HEDGE.test(sentence) && !IS_QUESTION.test(sentence);
      add({ kind: hedged ? "assumption" : "plain", text: sentence });
    }
  };

  const start = matches[0]?.index ?? reply.length;
  if (start > 0 || matches.length === 0) addPlain(reply.slice(0, start));

  matches.forEach((match, i) => {
    const end = i === matches.length - 1 ? undefined : matches[i + 1].index;
    const cited = match.slice(1, 8).find(Boolean);
    const source = cited ? SOURCE_BY_NAME.get(sourceKey(cited)) : undefined;
    const known = source ? DIRECTORY.get(source) : undefined;

    const sentences = reply.slice(match.index + match[0].length, end).split(SENTENCE_BREAK);
    // "По прайс-листу. Годовой ..." cites the next sentence: the piece before it says nothing.
    if (sentences.length > 1 && !/[\p{L}\p{N}]/u.test(sentences[0])) {
      sentences.splice(0, 2, sentences[0] + sentences[1]);
    }
    sentences.forEach((sentence, n) => {
      const text = n === 0 ? match[0] + sentence : sentence;
      const matchesDirectory =
        !IS_QUESTION.test(sentence) && known?.some((fact) => statesFact(sentence, fact));
      if (source && matchesDirectory) add({ kind: "fact", source, text });
      else if (n > 0) addPlain(text);
      else add({ kind: cited ? "unverified" : "assumption", text });
    });
  });

  return segments;
}
