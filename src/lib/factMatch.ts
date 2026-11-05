/**
 * Decides whether a spoken sentence states a directory fact. Comparing text fails on true
 * sentences, because speech writes "одну тысячу" and "в семь вечера" where the directory has
 * "1000" and "19:00". So both sides become tokens of value, and the vocabulary is closed:
 * the numbers must be equal, every meaningful word of the fact present, and nothing else
 * meaningful said. Anything unknown, like "около", "не" or "%", breaks the match.
 */

const NUMBER_WORDS = new Map<string, number>(
  (
    [
      [0, "ноль нуль нуля zero"],
      [1, "один одна одну одно одного одной одним one"],
      [2, "два две двух двум двумя two"],
      [3, "три трех трем тремя three"],
      [4, "четыре четырех четырем четырьмя four"],
      [5, "пять пяти пятью five"],
      [6, "шесть шести шестью six"],
      [7, "семь семи семью seven"],
      [8, "восемь восьми восемью eight"],
      [9, "девять девяти девятью nine"],
      [10, "десять десяти десятью ten"],
      [11, "одиннадцать одиннадцати eleven"],
      [12, "двенадцать двенадцати twelve"],
      [13, "тринадцать тринадцати thirteen"],
      [14, "четырнадцать четырнадцати fourteen"],
      [15, "пятнадцать пятнадцати fifteen"],
      [16, "шестнадцать шестнадцати sixteen"],
      [17, "семнадцать семнадцати seventeen"],
      [18, "восемнадцать восемнадцати eighteen"],
      [19, "девятнадцать девятнадцати nineteen"],
      [20, "двадцать двадцати twenty"],
      [30, "тридцать тридцати thirty"],
      [40, "сорок сорока forty"],
      [50, "пятьдесят пятидесяти fifty"],
      [60, "шестьдесят шестидесяти sixty"],
      [70, "семьдесят семидесяти seventy"],
      [80, "восемьдесят восьмидесяти eighty"],
      [90, "девяносто девяноста ninety"],
      [100, "сто ста"],
      [200, "двести двухсот"],
      [300, "триста трехсот"],
      [400, "четыреста четырехсот"],
      [500, "пятьсот пятисот"],
      [600, "шестьсот шестисот"],
      [700, "семьсот семисот"],
      [800, "восемьсот восьмисот"],
      [900, "девятьсот девятисот"],
    ] as [number, string][]
  ).flatMap(([value, forms]) => forms.split(" ").map((form) => [form, value] as [string, number])),
);
const THOUSAND = new Set(["тысяча", "тысячи", "тысячу", "тысяч", "тысяче", "тысячей", "тыс", "thousand"]);
const HUNDRED = "hundred";

/** Different words for one thing. Only pairs that mean the same in every directory entry. */
const SAME_THING: [RegExp, string][] = [
  [/^(доллар|долл$|бакс|dollar|buck|usd$)/, "$"],
  [/^(абонемент|подписк|membership|subscription)/, "абонемент"],
  [/^(заняти|тренирово?к|workout|session|training$|class(es)?$)/, "тренировка"],
  [/^(кг$|кило$|килограмм|kg$|kilo(gram)?s?$)/, "кг"],
  [/^(метр|metre|meter)/, "метр"],
  [/^(минут|мин$|minute|min$)/, "минут"],
  [/^(человек|люд|people$|persons?$)/, "человек"],
  [/^(annual|yearly|year)/, "year"],
  [/^(monthly|months?)$/, "month"],
  [/^(открыт|работает|работаем|open)/, "открыт"],
  [/^(to|through|until)$/, "до"],
];
/** These are compared exactly: "тренер" must not pass for the canonical "тренировка". */
const CANONICAL = new Set(SAME_THING.map(([, word]) => word));

/**
 * Words that can be said anywhere without claiming anything. Never add one that changes the
 * value or adds a claim: "не", "около", "до", "только" (it makes a true partial answer false),
 * "сейчас" or "будет" (the directory knows neither the present moment nor the future).
 */
const NEUTRAL = new Set(
  `стоит стоят стоить стоимость цена составляет составит обойдется обойдутся это есть имеется
   преподает тренирует
   нас мы у в во на по за из и а к при всего ровно просто указано каждую каждый
   клуб клуба клубе клубом зал зале вмещает рассчитан принимает
   проходит проходят идет идут занимается ведет длиной срок
   the a an is are be costs cost price priced at on in for of per and we have has there runs
   run club gym it its each long holds fits covers every`.split(/\s+/),
);

/** Fine where the entry has them, and optional there, but a claim anywhere else: "from $1000". */
const ONLY_IF_IN_ENTRY = new Set("с со from up with открыт".split(" "));

/** A word right before a number that decides what the number means: "с 45", "до 30". */
const BOUNDS = new Set(["с", "со", "from", "до", "от"]);
const BEFORE_A_TIME = new Set(["в", "во", "с", "со", "до", "at", "from", "to", "until"]);

/** "в половине восьмого" names the hour being approached. */
const ORDINAL_HOUR = new Map(
  "первого второго третьего четвертого пятого шестого седьмого восьмого девятого десятого одиннадцатого двенадцатого"
    .split(" ")
    .map((word, i) => [word, i + 1] as const),
);

const WEEKDAYS = [
  /^(понедельн|monday)/,
  /^(вторник|tuesday)/,
  /^(сред|wednesday)/,
  /^(четверг|thursday)/,
  /^(пятниц|friday)/,
  /^(суббот|saturday)/,
  /^(воскресен|sunday)/,
];
const weekdayOf = (word: string) => WEEKDAYS.findIndex((day) => day.test(word));

const isNumber = (token: string) => /^\d/.test(token);
const isNeutral = (word: string) => NEUTRAL.has(word) || /^(наш|our$)/.test(word);

/** Sequential words become a value or, for "семь тридцать", a time of day. */
function readNumberWords(run: string[]): string[] {
  const values: number[] = [];
  let total = 0;
  let current = 0;
  let open = false;
  const flush = () => {
    if (open) values.push(total + current);
    total = 0;
    current = 0;
    open = false;
  };
  for (const word of run) {
    if (THOUSAND.has(word)) {
      total += (current || 1) * 1000;
      current = 0;
      open = true;
    } else if (word === HUNDRED) {
      current = (current || 1) * 100;
      open = true;
    } else {
      const value = NUMBER_WORDS.get(word) as number;
      // A number can only continue into a smaller place: "сто двадцать", not "семь тридцать".
      const place = current === 0 ? Infinity : current % 100 === 0 ? 100 : current % 10 === 0 ? 10 : 1;
      if (value === 0 || value >= place) flush();
      current += value;
      open = true;
      if (value === 0) flush();
    }
  }
  flush();

  // "ноль семь тридцать" reads a clock digit by digit.
  if (values.length === 3 && values[0] === 0 && values[1] <= 9 && values[2] >= 10 && values[2] <= 59) {
    return [`${values[1]}:${values[2]}`];
  }
  const [hour, minutes, rest] = values;
  if (values.length === 2 && hour <= 23 && minutes >= 10 && minutes <= 59) return [`${hour}:${minutes}`];
  if (values.length >= 2 && hour <= 23 && minutes === 0 && (rest ?? 0) === 0) return [`${hour}:00`];
  return values.map(String);
}

function canonicalNumber(token: string, previous: string | undefined): string {
  const time = /^(\d{1,2})[:.](\d{2})$/.exec(token);
  if (time && previous !== "$" && Number(time[1]) <= 23 && Number(time[2]) <= 59) {
    return `${Number(time[1])}:${time[2]}`;
  }
  // Two zeros at most: three digits after a separator are a thousands group, not cents.
  const whole = /^(\d+)[.,]0{1,2}$/.exec(token);
  if (whole) return String(Number(whole[1]));
  return /^\d+$/.test(token) ? String(Number(token)) : token;
}

type DayPart = "morning" | "afternoon" | "night";

/** "вечера", "7 pm", "7 p.m.", "seven in the evening", with how many tokens they take. */
function readDayPart(tokens: string[], at: number): { part: DayPart; length: number } | null {
  const [a, b, c] = [tokens[at], tokens[at + 1], tokens[at + 2]];
  if (a === "in" && b === "the") {
    if (c === "morning") return { part: "morning", length: 3 };
    if (c === "afternoon" || c === "evening") return { part: "afternoon", length: 3 };
    return null;
  }
  if (b === "m" && a === "a") return { part: "morning", length: 2 };
  if (b === "m" && a === "p") return { part: "afternoon", length: 2 };
  if (a === "утра" || a === "am") return { part: "morning", length: 1 };
  if (a === "вечера" || a === "дня" || a === "pm") return { part: "afternoon", length: 1 };
  if (a === "ночи") return { part: "night", length: 1 };
  return null;
}

/** On a 24-hour clock, or null for what no clock says: "19 утра". */
function applyDayPart(time: string, part: DayPart): string | null {
  const [hour, minutes = "00"] = time.split(":");
  const h = Number(hour);
  if (!Number.isInteger(h) || h > 12) return null;
  if (part === "morning") return `${h === 12 ? 0 : h}:${minutes}`;
  if (part === "afternoon") return `${h === 12 ? 12 : h + 12}:${minutes}`;
  // At night 11 is 23:00 and 2 is 02:00: "10 ночи" is not the morning class at 10:00.
  return `${h === 12 ? 0 : h >= 6 ? h + 12 : h}:${minutes}`;
}

function tokenize(sentence: string): string[] {
  const text = sentence
    .normalize("NFC")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[  ]/g, " ")
    .replace(/['’](s|re)\b/g, "")
    // Set phrases around a price or a period that add nothing to the claim.
    .replace(/будет стоить/g, "стоит")
    .replace(/(стоит|обойдется) вам/g, "$1")
    .replace(/will cost( you)?/g, "costs")
    .replace(/(?<!\p{L})(?:один|одну|1)\s+(год|месяц)/gu, "$1")
    .replace(/(?<![a-z\d])(?:one|1)[- ](year|month)/g, "$1")
    .replace(/(?<!\p{L})(в|во|at)\s+(\d{1,2})\s+([0-5]\d)(?![\d\p{L}])/gu, "$1 $2:$3")
    .replace(/(\d)-(\p{L})/gu, "$1 $2")
    .replace(/(?<![\d.,:])\d{1,3}(?:[ ,.]\d{3})+(?!\d)/g, (group) => group.replace(/[ ,.]/g, ""))
    // "19-00" is a time, "3-10" a range: only round minutes are read as minutes.
    .replace(/(?<![\d:])(\d{1,2})-(00|15|30|45)(?!\d)/g, "$1:$2")
    .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 до $2")
    // A range of days is not the list of days in an entry: it stays a range and must match one.
    .replace(/(\p{L}+)\s*[-–—]\s*(\p{L}+)/gu, (pair, a: string, b: string) =>
      weekdayOf(a) >= 0 && weekdayOf(b) >= 0 ? `${a} до ${b}` : pair,
    )
    // Only what closes a word goes: a dash, a star or a dot against a number stays and breaks
    // the match, because "—1000", "$1000*" and ".45" are not the values in the directory.
    .replace(
      /[.,:](?!\p{N})|(?<=\p{L})-(?=\p{L})|(?<=\s)-(?=\s)|[—–](?![\p{N}\p{Sc}])|(?<!\p{N})[*_]|[;!?…«»"'’()]/gu,
      " ",
    );
  const raw = text.match(/\p{L}+|\p{N}+(?:[.,:]\p{N}+)*|\S/gu) ?? [];

  const tokens: string[] = [];
  const isNumberWord = (word: string | undefined) =>
    word !== undefined && (NUMBER_WORDS.has(word) || THOUSAND.has(word) || word === HUNDRED);
  for (let i = 0; i < raw.length; i++) {
    if (/^\d+$/.test(raw[i]) && THOUSAND.has(raw[i + 1])) {
      tokens.push(String(Number(raw[i]) * 1000));
      i++;
      continue;
    }
    if (!isNumberWord(raw[i])) {
      tokens.push(isNumber(raw[i]) ? canonicalNumber(raw[i], tokens[tokens.length - 1]) : raw[i]);
      continue;
    }
    const run: string[] = [];
    while (isNumberWord(raw[i]) || (raw[i] === "and" && isNumberWord(raw[i + 1]) && run.length > 0)) {
      if (raw[i] !== "and") run.push(raw[i]);
      i++;
    }
    i--;
    tokens.push(...readNumberWords(run));
  }

  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    const approaching = /^половин/.test(token) ? ORDINAL_HOUR.get(tokens[i + 1]) : undefined;
    if (approaching !== undefined) {
      token = `${approaching === 1 ? 12 : approaching - 1}:30`;
      i += 1;
    } else if (token === "half" && tokens[i + 1] === "past" && /^\d{1,2}$/.test(tokens[i + 2] ?? "")) {
      token = `${tokens[i + 2]}:30`;
      i += 2;
    }
    if (isNumber(token)) {
      // Only after a word that introduces a time: "в 19 часов" is a time, "1000 часов" and
      // "for 10 hours" are durations, and their word stays to break the match.
      const hourWord = /^(час|часа|часов|hour|hours)$/.test(tokens[i + 1]) || (tokens[i + 1] === "o" && tokens[i + 2] === "clock");
      if (hourWord && BEFORE_A_TIME.has(tokens[i - 1]) && /^\d{1,2}$/.test(token) && Number(token) <= 23) {
        i += tokens[i + 1] === "o" ? 2 : 1;
        const minutes = tokens[i + 1];
        if (/^\d{1,2}$/.test(minutes ?? "") && Number(minutes) <= 59 && /^(минут|мин$)/.test(tokens[i + 2] ?? "")) {
          token = `${token}:${minutes.padStart(2, "0")}`;
          i += 2;
        } else {
          token = `${token}:00`;
        }
      }
      if (tokens[i + 1] === "м" || tokens[i + 1] === "m") tokens[i + 1] = "метр";
      const dayPart = readDayPart(tokens, i + 1);
      const shifted = dayPart && /^\d{1,2}(:\d{2})?$/.test(token) ? applyDayPart(token, dayPart.part) : null;
      if (dayPart && shifted) {
        token = shifted;
        i += dayPart.length;
      }
      result.push(token);
      continue;
    }
    const same = SAME_THING.find(([pattern]) => pattern.test(token));
    result.push(same ? same[1] : token);
  }
  return result;
}

const ADJECTIVE_ENDING = /(ая|яя|ое|ее|ый|ий|ой|ую|юю|ые|ие|ого|его|ому|ему|ым|им|ых|их)$/;

/**
 * Same word in another form: "дорожки"/"дорожек", "месяц"/"месячная", "первая"/"первое", not
 * "тренер"/"тренировка" or "free"/"freeze". English takes known endings only: a shared start
 * means little in short words.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (CANONICAL.has(a) || CANONICAL.has(b)) return false;
  if (!/^\p{L}/u.test(a) || !/^\p{L}/u.test(b)) return false;
  if (/^[a-z]/.test(a) || /^[a-z]/.test(b)) {
    const stem = (word: string) => word.replace(/(es|s)$/, "");
    return stem(a) === stem(b);
  }
  // "включал" is not "включает": the directory speaks of now. Long words only, for "зал"/"зале".
  const isPast = (word: string) => word.length >= 5 && /[аеиоуя]л[аои]?$/.test(word);
  if (isPast(a) !== isPast(b)) return false;
  if (a.replace(ADJECTIVE_ENDING, "") === b.replace(ADJECTIVE_ENDING, "")) return true;
  let common = 0;
  while (common < a.length && a[common] === b[common]) common++;
  return common >= Math.max(3, Math.ceil(Math.min(a.length, b.length) * 0.7));
}

/** A number with what decides its meaning: the word before it and the thing it counts. */
interface Quantity {
  value: string;
  bound: string;
  unit: string;
}

export interface CompiledFact {
  quantities: Quantity[];
  words: string[];
}

export function compileFact(text: string): CompiledFact {
  const tokens = tokenize(text);
  const quantities = tokens.flatMap((value, i) => {
    if (!isNumber(value)) return [];
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    const counts =
      after !== undefined && /^\p{L}/u.test(after) && after !== "до" && !isNeutral(after) && !ONLY_IF_IN_ENTRY.has(after);
    return [{ value, bound: BOUNDS.has(before) ? before : "", unit: counts ? after : "" }];
  });
  return { quantities, words: tokens.filter((t) => !isNumber(t)) };
}

/** "в 19" states the entry's 19:00; a time on the other side never stands for a plain number. */
function sameValue(said: Quantity, entry: Quantity): boolean {
  return said.value === entry.value || (said.unit === "" && `${said.value}:00` === entry.value);
}

function sameQuantity(said: Quantity, entry: Quantity): boolean {
  if (!sameValue(said, entry)) return false;
  // "стоит с 45" is "from 45". The entry's "с" before a time may go unsaid, its "до" may not.
  if (said.bound && said.bound !== entry.bound) return false;
  if (!said.bound && (entry.bound === "до" || entry.bound === "от")) return false;
  // Without this the right number counts the wrong thing: "подписка на 120 месяцев".
  return said.unit === "" || sameWord(said.unit, entry.unit);
}

export function statesFact(sentence: string, fact: CompiledFact): boolean {
  const said = compileFact(sentence);

  // In order, because the values alone do not make the statement: "с 23:00 до 06:30" and "пакет
  // из 400 занятий за 10 долларов" hold the right numbers. A true reordering is rejected too.
  if (said.quantities.length !== fact.quantities.length) return false;
  if (!said.quantities.every((quantity, i) => sameQuantity(quantity, fact.quantities[i]))) return false;

  // Against the entry's meaningful words only, or "стоил" would pass for its neutral "стоит".
  const meaningful = fact.words.filter((w) => !isNeutral(w));
  for (const word of said.words) {
    if (!isNeutral(word) && !meaningful.some((w) => sameWord(w, word))) return false;
  }

  // Naming some of the days is still true, as long as they keep their order: "с пятницы по
  // понедельник" is a different range. A day outside the fact failed the check above.
  const factDays = fact.words.map(weekdayOf).filter((day) => day >= 0);
  const saidDays = said.words.map(weekdayOf).filter((day) => day >= 0);
  if (factDays.length > 0 && saidDays.length === 0) return false;
  let position = 0;
  for (const day of saidDays) {
    while (position < factDays.length && factDays[position] !== day) position++;
    if (position === factDays.length) return false;
  }

  return fact.words
    .filter((w) => !isNeutral(w) && !ONLY_IF_IN_ENTRY.has(w) && w !== "$" && weekdayOf(w) < 0)
    .every((w) => said.words.some((word) => sameWord(w, word)));
}
