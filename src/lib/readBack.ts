import { searchServices } from "./catalog";
import { dateRefusal } from "./formModel";
import type { ClientProfile } from "./formModel";

type Field = keyof ClientProfile;

// The prompt makes the agent read every value back in this shape; this is what fills the form
// when the model never calls update_form.
// A value ends at "Верно?" or where the next read-back starts: the model sometimes chains
// several with one question at the end, and the first value then swallowed all the rest.
const READ_BACK =
  /(?:noting\s+(?:the\s+|your\s+)?|записываю\s+)([^:.?!]+?)\s*:\s*((?:(?!(?:noting|записываю)\s).)+?)\s*[.,]?\s*(?:(?:correct|верно)\s*\?|(?=(?:noting|записываю)\s))/giu;

// Plate before phone: "номер машины" is a plate, a bare "номер" is the phone.
const LABELS: [RegExp, Field][] = [
  [/^(имя|name)/iu, "name"],
  [/^(госномер|номер машины|номерной|plate)/iu, "plate"],
  [/^(телефон|номер|phone|number)/iu, "phone"],
  [/^(машин|автомобил|авто|car|vehicle)/iu, "car"],
  [/^(услуг|service)/iu, "service"],
  [/^(дат|date)/iu, "date"],
];

// "n't" splits off as "t" under \p{L}+, so "isn't right" still reads as a no.
const NO = new Set(["no", "not", "nope", "wrong", "incorrect", "t", "нет", "не", "неверно", "неправильно"]);
// What follows a "но" decides: "да, но телефон другой" after a name read-back corrects something
// else and the name stays; after a phone read-back it takes the yes back.
const BUT = new Set(["but", "except", "но", "кроме"]);
// "да, не сомневайтесь" and "no problem" reassure; the negation in them is not an answer.
const REASSURES = new Set(["сомневайтесь", "сомневайся", "вопрос", "против", "волнуйтесь", "переживайте", "беспокойтесь", "problem", "doubt", "worries"]);

const L = "АВЕКМНОРСТУХ";
const LATIN = "ABEKMHOPCTYX";

function fieldFor(label: string): Field | undefined {
  const l = label.trim().toLowerCase();
  return LABELS.find(([re]) => re.test(l))?.[1];
}

const MONTHS: [RegExp, number][] = [
  [/^(январ|jan)/, 1], [/^(феврал|feb)/, 2], [/^(март|mar)/, 3], [/^(апрел|apr)/, 4], [/^(ма[яй]|may)/, 5],
  [/^(июн|jun)/, 6], [/^(июл|jul)/, 7], [/^(август|aug)/, 8], [/^(сентябр|sep)/, 9], [/^(октябр|oct)/, 10],
  [/^(ноябр|nov)/, 11], [/^(декабр|dec)/, 12],
];
const DAY_WORDS = ["перв", "втор", "трет", "четв", "пят", "шест", "седьм", "восьм", "девят", "десят",
  "одиннадцат", "двенадцат", "тринадцат", "четырнадцат", "пятнадцат", "шестнадцат", "семнадцат",
  "восемнадцат", "девятнадцат", "двадцат"];
const HOUR_WORDS = ["од", "дв", "тр", "чет", "пят", "шест", "сем", "восем", "девят", "десят", "одиннадцат",
  "двенадцат", "тринадцат", "четырнадцат", "пятнадцат", "шестнадцат", "семнадцат", "восемнадцат"];

// Longest stem first, so "пятнадцат" is not read as "пят".
const stem = (words: string[], w: string) => {
  let best = -1;
  words.forEach((s, i) => { if (w.startsWith(s) && (best < 0 || s.length > words[best].length)) best = i; });
  return best < 0 ? undefined : best + 1;
};

function spokenDay(words: string[]): number | undefined {
  if (/^\d{1,2}/.test(words[0] ?? "")) return parseInt(words[0], 10);
  const tens = words[0] === "двадцать" ? 20 : words[0] === "тридцать" ? 30 : 0;
  const unit = stem(DAY_WORDS, words[tens ? 1 : 0] ?? "");
  if (words[0]?.startsWith("тридцат")) return 30;
  return unit === undefined ? undefined : tens + unit;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "двадцать третьего октября в пять часов" → "2026-10-23 17:00". The model is told to say dates
 * in digits and sometimes still uses words, which the form cannot hold.
 */
function spokenDate(raw: string, now: Date): string | undefined {
  const t = raw.toLowerCase().replace(/[,.]/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  const mi = words.findIndex((w) => MONTHS.some(([re]) => re.test(w)));
  let day: number | undefined;
  let month: number | undefined;
  let rest: string[];
  if (mi >= 0) {
    month = MONTHS.find(([re]) => re.test(words[mi]))![1];
    // "October 23" puts the day after the month, "23 октября" before it.
    day = spokenDay(words.slice(Math.max(0, mi - 2), mi).slice(-(words[mi - 2] === "двадцать" || words[mi - 2] === "тридцать" ? 2 : 1)))
      ?? spokenDay(words.slice(mi + 1));
    rest = words.slice(mi + 1);
  } else {
    const shift = /^(сегодня|today)$/.test(words[0] ?? "") ? 0 : /^(завтра|tomorrow)$/.test(words[0] ?? "") ? 1
      : /^послезавтра$/.test(words[0] ?? "") ? 2 : undefined;
    if (shift === undefined) return undefined;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift);
    [day, month, rest] = [d.getDate(), d.getMonth() + 1, words.slice(1)];
  }
  if (!day || !month || day > 31) return undefined;

  const yearWord = rest.find((w) => /^\d{4}$/.test(w));
  // No year said means the next such day from today, never one already gone.
  let year = yearWord ? +yearWord : now.getFullYear();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!yearWord && new Date(year, month - 1, day) < today) year += 1;
  const date = `${year}-${pad(month)}-${pad(day)}`;

  const at = rest.slice(rest.findIndex((w) => w === "в" || w === "at") + 1);
  const clock = /^(\d{1,2})(?::(\d{2}))?$/.exec(at[0] ?? "");
  let hour = clock ? +clock[1] : stem(HOUR_WORDS, at[0] ?? "") ?? (at[0] === "час" ? 1 : undefined);
  if (hour === undefined || !rest.some((w) => w === "в" || w === "at")) return date;
  const minute = clock?.[2] ? +clock[2] : at[1] === "тридцать" || at[1] === "thirty" ? 30 : 0;
  // The shop opens at 09:00, so "в пять" is five in the evening.
  if (hour < 9 && !/утра|am/.test(t)) hour += 12;
  return `${date} ${pad(hour)}:${pad(minute)}`;
}

function normalise(field: Field, raw: string, now: Date): string {
  if (field === "plate") return raw.replace(/\s/g, "").toUpperCase().replace(/[A-Z]/g, (c) => L[LATIN.indexOf(c)] ?? c);
  if (field === "date") {
    // Spoken as DD.MM.YYYY; the form keeps YYYY-MM-DD with the time after it.
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[\s,]+(?:в\s+|at\s+)?(\d{1,2}):(\d{2}))?$/iu.exec(raw);
    const day = m && `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const value = m ? (m[4] ? `${day} ${m[4].padStart(2, "0")}:${m[5]}` : day!) : spokenDate(raw, now) ?? raw;
    // However it was said, a date the shop cannot take is a mis-heard one: the agent has to
    // ask again, not book it.
    return dateRefusal(value, now) ? "" : value;
  }
  if (field === "service") {
    // Only a price-list service is bookable; anything else is left for the agent to clarify.
    const s = searchServices(raw)[0];
    return s ? (/\p{Script=Cyrillic}/u.test(raw) ? s.ru : s.en) : "";
  }
  return raw;
}

/** Every value the agent read back in this reply, by form field. */
export function readBacks(text: string, now = new Date()): Partial<ClientProfile> {
  const out: Partial<ClientProfile> = {};
  for (const m of text.matchAll(READ_BACK)) {
    const field = fieldFor(m[1]);
    const value = field && normalise(field, m[2].trim(), now);
    if (field && value) out[field] = value;
  }
  return out;
}

const YES = new Set(["да", "верно", "правильно", "точно", "ага", "угу", "конечно", "yes", "yeah", "yep", "correct", "right", "sure"]);

/** True when the customer's answer confirms what was just read back. */
export function accepts(text: string, about?: Field): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some((w) => YES.has(w)) && !rejects(text, about);
}

/** True when the customer's answer rejects what was just read back; `about` is the field that was. */
export function rejects(text: string, about?: Field): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const no = (list: string[]) => list.some((w, i) => NO.has(w) && !REASSURES.has(list[i + 1]));
  const but = words.findIndex((w) => BUT.has(w));
  if (but < 0) return no(words);
  const tail = words.slice(but + 1);
  const named = tail.map(fieldFor).filter(Boolean);
  // A no after the "but" stands unless it is plainly about another field.
  return no(words.slice(0, but)) || (about !== undefined && named.includes(about)) || (no(tail) && !named.length);
}
