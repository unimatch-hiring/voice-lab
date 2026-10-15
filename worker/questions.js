/**
 * Training questions for the coach, drawn live from gotquestions.online. The site has no
 * JSON API: a pack page embeds its questions in the Next.js flight payload, and that is
 * what is read here. Texts are never stored — only the pack ids below are ours.
 */

/**
 * Where a question comes from and how hard it may be, by the share of teams that took it
 * on the site. The school pool is the Лига разума series, the children's floor; its packs
 * mostly have no results, so an unplayed question there counts as children's level. The
 * student pool is championships rated 3.2–4.7, below the front-page packs near 5.
 */
export const POOLS = {
  school: { packs: [7258, 7259, 7260, 7261, 7262, 7263, 7264, 7265, 7266], minTake: 70, maxTake: 100, unplayed: true },
  students: { packs: [5710, 6540, 6247, 6355, 6730, 6296], minTake: 30, maxTake: 75, unplayed: false },
};

const LETTER = "А-ЯЁа-яё";
const REPLACED_WORD = new RegExp(
  `(?<![${LETTER}])(ОН|ОНА|ОНО|ОНИ|ЕГО|ЕЁ|ЕЕ|ЕЮ|ИХ|ИМИ|ЕМУ|ЕЙ|ИМ|НИМ|НИХ|НЕЙ|НЕГО|НЕЁ|НЁМ|НЕМ|НЕЧТО|ЭТ[А-ЯЁ]*|ТАК[А-ЯЁ]*|ИКС[А-ЯЁ]*|ИГРЕК[А-ЯЁ]*|АЛЬФ[А-ЯЁ]*|БЕТ[А-ЯЁ]*|ДЕЛА[А-ЯЁ]*|ПЕРВ[А-ЯЁ]*|ВТОР[А-ЯЁ]*)(?![${LETTER}])`,
);
const NAMED_KIND =
  /Назовите[^.?!]{0,40}?(фильм|город|стран|професси|животн|птиц|рыб|насеком|растени|цвет|писател|поэт|художник|композитор|блюд|напит|овощ|фрукт|ягод|рек[уи]|остров|планет|имя|фамили|инструмент|вид спорта|игр[уы]|книг|роман|песн|пород|минерал|металл|столиц|язык)|начинающ[а-яё]* на|на букву|происхождения/i;

/** Stress marks sit inside words and would split a replaced word in two. */
const plain = (text) => text.normalize("NFC").replace(/\u0301/g, "");

/**
 * What each trainable skill looks like in a question. Heuristics: they pick a question
 * where the skill pays off, they do not prove it is the only way in.
 */
export const SKILLS = {
  replacement: (q) => /замен/i.test(q.text) || REPLACED_WORD.test(plain(q.text)),
  homogeneous: (q) => NAMED_KIND.test(plain(q.text)),
  any: () => true,
};

/** A handout, an audio clip or a multi-part answer cannot be played by voice alone. */
function voiceable(q) {
  if (q.takenDown || q.razdatkaText || q.razdatkaPic || q.audio) return false;
  if (/блиц|дуплет/i.test(q.text)) return false;
  return !/^\s*1[).]/m.test(q.answer ?? "");
}

/** The share of teams that took the question, in percent, or null when it was not played. */
export function takePercent(q) {
  const first = Number.parseFloat(q.complexity?.[0]);
  return Number.isFinite(first) ? first : null;
}

const PUSH = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/** The object literal starting at `start`, found by matching braces outside strings. */
function objectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Every question on a pack page, once each: the payload repeats some of them. */
export function packQuestions(html) {
  let flight = "";
  for (const m of html.matchAll(PUSH)) flight += JSON.parse(`"${m[1].replace(/\n/g, "\\n")}"`);
  const found = new Map();
  for (const m of flight.matchAll(/\{"id":\d+,"number":\d+,"text":/g)) {
    const literal = objectAt(flight, m.index);
    if (!literal) continue;
    try {
      const q = JSON.parse(literal);
      found.set(q.id, q);
    } catch {
      // A truncated or reference-laden object is skipped, not fatal: the rest still serve.
    }
  }
  return [...found.values()];
}

export function fits(q, { skill, audience }) {
  const pool = POOLS[audience];
  if (!voiceable(q) || !SKILLS[skill](q)) return false;
  const take = takePercent(q);
  if (take === null) return pool.unplayed;
  return take >= pool.minTake && take <= pool.maxTake;
}

const shuffled = (items, random) =>
  items
    .map((item) => [random(), item])
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);

/** Pack pages fetched per request: each one is a subrequest and a hit on someone else's site. */
const MAX_PACKS = 2;

async function fetchPack(pack, fetchImpl) {
  const r = await fetchImpl(`https://gotquestions.online/pack/${pack}`, {
    headers: { "user-agent": "voice-lab coach (https://unimatch-hiring.github.io/voice-lab/)" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`gotquestions answered ${r.status}`);
  return packQuestions(await r.text());
}

/**
 * One question per skill for the audience, never the same one twice, null in place of a
 * skill the packs tried had none for. All skills draw from the same packs, each read once
 * and cached at the edge for a day, so the site is reached a few times a day, not per session.
 */
export async function findQuestions({ skills, audience }, { fetchImpl = fetch, random = Math.random } = {}) {
  const packs = shuffled(POOLS[audience].packs, random).slice(0, MAX_PACKS);
  const pages = new Map();
  const page = (pack) => {
    if (!pages.has(pack)) pages.set(pack, fetchPack(pack, fetchImpl));
    return pages.get(pack);
  };
  const taken = new Set();
  const found = [];
  for (const skill of skills) {
    let picked = null;
    for (const pack of packs) {
      const candidates = (await page(pack)).filter((q) => !taken.has(q.id) && fits(q, { skill, audience }));
      if (candidates.length === 0) continue;
      picked = candidates[Math.floor(random() * candidates.length)];
      break;
    }
    if (picked) taken.add(picked.id);
    found.push(
      picked && {
        id: picked.id,
        text: picked.text,
        answer: picked.answer,
        zachet: picked.zachet,
        comment: picked.comment,
        takePercent: takePercent(picked),
        url: `https://gotquestions.online/question/${picked.id}`,
      },
    );
  }
  return found;
}
