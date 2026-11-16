/**
 * Splits an agent reply into what a source backed and what the agent supplied itself.
 *
 * A heuristic, not a proof: it shows the interviewer where the agent stayed on data and
 * where it guessed. A fact written "subject: values" binds its values to that subject, so a
 * price said beside a service has to be that service's price. docs/pipeline.md has the rules.
 */
export type Mark = "fact" | "assumption";
export interface Segment {
  text: string;
  mark?: Mark;
}

// Thousands may be split by a space, nbsp or narrow nbsp: "2 500", as TTS-friendly LLMs write prices.
const NUMBER = /\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|\d{1,3}(?:[   ]\d{3})+|\d+/g;
const UNIT = String.raw`(?:\s?(?:₽|руб\p{L}*|rubles?|roubles?|минут\p{L}*|мин\.?|minutes?|min))?`;
const EDGE_L = String.raw`(?<![\p{L}\p{N}])`;
const EDGE_R = String.raw`(?![\p{L}\p{N}])`;
const HEDGE = new RegExp(
  `${EDGE_L}(?:предположительно|наверное|наверно|примерно|скорее всего|вероятно|возможно|i assume|i'd assume|probably|likely|approximately|roughly|maybe)${EDGE_R}`,
  "giu",
);

// The unit is the field: "6 months" backs neither "6 лет" nor "6 минут".
const UNITS: [string, RegExp][] = [
  ["money", /^\s?(?:₽|руб|rub|roub)/iu],
  ["min", /^\s?(?:мин|min)/iu],
  ["hour", /^\s?(?:час|hour)/iu],
  ["month", /^\s?(?:месяц|мес\.|month)/iu],
  ["year", /^\s?(?:лет|год|year)/iu],
  ["km", /^\s?(?:км|km|килом)/iu],
];
/** "" is a bare number; in a fact, "other" is a unit the list above does not know. */
const unitAfter = (s: string, inFact = false): string =>
  UNITS.find(([, re]) => re.test(s))?.[0] ?? (inFact && /^(?:[.,]\d|\s?\p{L})/u.test(s) ? "other" : "");
const fits = (fact: string, said: string) => !said || fact === said || fact === "";

// "не с 09:00 до 19:00" denies both ends, so a denial carries across a range word.
const NEGATED = /(?<![\p{L}])(?:не|not)\s+(?:(?:с|со|в|во|за|на|по|до|от|from|at|for|in|to|till|until)\s+)?$/iu;
const RANGE = /^\s*(?:до|по|и|или|to|till|until|and|or|[–—-])\s*$/iu;
// "стоит 4000" is a price though no ruble sign follows.
const COSTS = /(?<![\p{L}])(?:сто[ия]т|стоимост\p{L}*|цен[аыу]|costs?|price)[^\d,;.!?]*$/iu;
const MONTHS = ["янв|jan", "фев|feb", "мар|mar", "апр|apr", "ма[йяе]$|may", "июн|jun", "июл|jul", "авг|aug", "сен|sep", "окт|oct", "ноя|nov", "дек|dec"].map(
  (m) => new RegExp(`^(?:${m})`, "iu"),
);
/** 1–12 when the word is a month name, else 0. */
const monthOf = (word?: string) => (word ? MONTHS.findIndex((re) => re.test(word)) + 1 : 0);
const PHONE = /^\+?\d[\d\s()-]{5,}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const SENTENCE = /[.!?…]+(?=\s|$)|\n/g;
const CLAUSE = /[.!?…]+(?=\s|$)|[,;](?=\s)|\n/g;

const digits = (s: string) => s.replace(/\D/g, "");
// "09:00" is said as "9:00".
const numKey = (s: string) => (s.includes(":") ? s.replace(/^0/, "") : digits(s));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// Each word keeps its first letters and lets the ending vary: "Замена масла" matches "замену масла".
function namePattern(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (w.length < 4 || !/^\p{L}+$/u.test(w) ? escape(w) : escape(w.slice(0, Math.max(3, w.length - 2))) + String.raw`\p{L}{0,3}`))
    .join(String.raw`\s+`);
}

interface Span {
  start: number;
  end: number;
  mark: Mark;
}
interface Value {
  key: string;
  unit: string;
}
/** Where the reply names a subject, with the values its fact gives it. */
interface Mention {
  start: number;
  end: number;
  values: Value[];
}

/** The stretch around `at` that no `stop` match cuts: a sentence, or a clause of one. */
function stretch(text: string, at: number, stop: RegExp): [number, number] {
  let from = 0;
  for (const m of text.matchAll(stop)) {
    if (m.index >= at) return [from, m.index];
    from = m.index + m[0].length;
  }
  return [from, text.length];
}

export function annotate(text: string, facts: Iterable<string>): Segment[] {
  const all: Value[] = [];
  const subjects: { pattern: string; values: Value[] }[] = [];
  const dates: number[][] = [];
  // Long digit runs (phones) are read back in pieces, so any piece of them counts.
  const runs: string[] = [];
  const names: string[] = [];
  for (const f of facts) {
    if (PHONE.test(f.trim()) && !ISO.test(f.trim())) {
      runs.push(digits(f));
      continue;
    }
    const colon = f.search(/:(?!\d)/);
    const head = colon > 0 && /\p{L}{3}/u.test(f.slice(0, colon)) && !/\d/.test(f.slice(0, colon)) ? f.slice(0, colon) : "";
    const values: Value[] = [];
    for (const m of f.slice(head.length).matchAll(NUMBER)) {
      const iso = ISO.exec(m[0]);
      if (iso) dates.push(iso.slice(1).map(Number));
      values.push({ key: numKey(m[0]), unit: iso ? "" : unitAfter(f.slice(head.length + m.index + m[0].length), true) });
    }
    all.push(...values);
    for (const s of head.split(/[,;]/)) if (/\p{L}{3}/u.test(s)) subjects.push({ pattern: namePattern(s), values });
    // A shop fact is a sentence; its comma-separated pieces ("АвтоЛаб", "ул. Моторная") are what gets quoted.
    for (const piece of f.split(/[,;]|:(?!\d)/)) {
      const words = piece.split(/\d/)[0];
      if (/\p{L}{3}/u.test(words)) names.push(namePattern(words));
    }
  }

  const spans: Span[] = [];
  if (names.length) {
    // Longest first, so "Замена тормозных колодок" wins over a shorter name inside it.
    names.sort((a, b) => b.length - a.length);
    const re = new RegExp(`${EDGE_L}(?:${names.join("|")})${EDGE_R}`, "giu");
    for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, mark: "fact" });
  }
  const mentions: Mention[] = subjects
    .flatMap(({ pattern, values }) =>
      [...text.matchAll(new RegExp(`${EDGE_L}(?:${pattern})${EDGE_R}`, "giu"))].map((m) => ({ start: m.index, end: m.index + m[0].length, values })),
    )
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((m, i, list) => !list.slice(0, i).some((longer) => longer.end > m.start && longer.end - longer.start > m.end - m.start));

  /** The subjects a number is said about: its clause's, else its sentence's, else the last one named. */
  const about = (start: number, end: number): Mention[] => {
    for (const [from, to] of [stretch(text, start, CLAUSE), stretch(text, start, SENTENCE)]) {
      const inside = mentions.filter((m) => m.start >= from && m.end <= to);
      const before = inside.filter((m) => m.end <= start);
      const after = inside.filter((m) => m.start >= end);
      // The same name can come from the prompt and from a tool, so one place may hold several.
      const near = [...before.filter((m) => m.start === before.at(-1)!.start), ...after.filter((m) => m.start === after[0].start)];
      if (near.length) return near;
    }
    const earlier = mentions.filter((m) => m.end <= start);
    return earlier.filter((m) => m.start === earlier.at(-1)!.start);
  };

  const num = new RegExp(`${EDGE_L}(?:${NUMBER.source})${UNIT}${EDGE_R}`, "gu");
  let denied = -1;
  for (const m of text.matchAll(num)) {
    const core = m[0].match(NUMBER)![0];
    const end = m.index + m[0].length;
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + core.length);
    const key = numKey(core);
    const bare = !core.includes(":") && !unitAfter(after);
    const unit = bare && COSTS.test(before) ? "money" : unitAfter(after);
    const has = (values: Value[]) => values.some((v) => v.key === key && fits(v.unit, unit));

    const negated = NEGATED.test(before) || (denied >= 0 && RANGE.test(text.slice(denied, m.index)));
    denied = negated ? end : -1;
    // "17 ноября" or "November 17": the month is part of the claim, though only the day is a number.
    const month = bare && key.length <= 2 ? monthOf(/^(?:-?(?:го|ое|е))?\s+(\p{L}+)/u.exec(after)?.[1]) || monthOf(/(\p{L}+)\s+$/u.exec(before)?.[1]) : 0;
    // A service named beside the number owns that field: its price, not any price on the list.
    const owners = unit ? about(m.index, end).filter((o) => o.values.some((v) => v.unit === unit)) : [];

    let backed: boolean;
    if (negated) backed = false;
    else if (month) backed = dates.some(([, mm, dd]) => mm === month && dd === Number(key));
    else if (owners.length) backed = owners.some((o) => has(o.values));
    // A date's parts and a phone's pieces back a bare number only: "45 рублей" is not part of a phone.
    else backed = has(all) || (bare && !unit && (dates.some((d) => d.includes(Number(key))) || runs.some((r) => r.includes(key))));
    spans.push({ start: m.index, end, mark: backed ? "fact" : "assumption" });
  }
  for (const m of text.matchAll(HEDGE)) spans.push({ start: m.index, end: m.index + m[0].length, mark: "assumption" });

  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Segment[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    if (s.start > at) out.push({ text: text.slice(at, s.start) });
    out.push({ text: text.slice(s.start, s.end), mark: s.mark });
    at = s.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
