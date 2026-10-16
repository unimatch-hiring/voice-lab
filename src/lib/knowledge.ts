/**
 * The coach's knowledge base, searched in the page. The agent's own RAG needs the
 * ElevenLabs account to upload files; this needs nothing but the SDK's contextual update,
 * so it works for anyone holding an interview key.
 *
 * Every `##` section of a file names its subject on its own (docs/knowledge.md), so a
 * section is the unit retrieved. Ranking is BM25 over crude Russian stems: a word is cut to
 * its first five letters, which is enough to match «замена» with «замену» and «раскрутка»
 * with «раскрутки» without a morphology dependency.
 */

export interface Section {
  title: string;
  text: string;
}

const STOP = new Set(
  "как что это для или они его она оно нас вас наш ваш так все уже еще если при над под без про чем где когда кто там тут вот был была были быть есть нет мне мой моя мои тебе тебя себя чтобы потом очень можно нужно надо только какой какие какая этот эта эти тот привет здравствуй здравствуйте спасибо пожалуйста пока хорошо ладно давай давайте дела находить найти научить научиться делать сделать показать покажи расскажи рассказать объясни объяснить помоги помочь хочу хотим".split(
    " ",
  ),
);

export function stems(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w));
}

/** The `##` sections of each file; the heading and source line above the first are not material. */
export function sectionsOf(files: string[]): Section[] {
  return files.flatMap((file) =>
    file
      .split(/^## /m)
      .slice(1)
      .map((part) => {
        const [title, ...body] = part.split("\n");
        return { title: title.trim(), text: body.join("\n").trim() };
      }),
  );
}

/** Below this a match is a shared common word, not a shared subject. */
const MIN_SCORE = 2;
/** A second section has to be at least this close to the best to come along. */
const KEEP_RATIO = 0.5;
const MAX_SECTIONS = 3;
/** Roughly a thousand tokens: background for one turn, not a second prompt. */
const MAX_CHARS = 3500;

/**
 * Builds the search over the given files. The result maps the person's words to the
 * material to hand the agent, or null when nothing in the base is about them.
 */
export function createKnowledge(files: string[]): (words: string) => string | null {
  const sections = sectionsOf(files);
  // The title counts twice: it is the one line written to say what the section is about.
  const docs = sections.map((s) => [...stems(s.title), ...stems(s.title), ...stems(s.text)]);
  const avgLength = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  const docFreq = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  // A stem in over half the sections («команда», «вопрос») says nothing about which one is meant.
  const idf = (t: string) => {
    const n = docFreq.get(t) ?? 0;
    return Math.max(0, Math.log((docs.length - n + 0.5) / (n + 0.5)));
  };

  return (words) => {
    const query = [...new Set(stems(words))];
    if (query.length === 0) return null;
    const ranked = docs
      .map((d, i) => {
        let score = 0;
        for (const t of query) {
          const tf = d.filter((x) => x === t).length;
          if (tf) score += (idf(t) * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.length) / avgLength));
        }
        return { section: sections[i], score };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0]?.score ?? 0;
    if (best < MIN_SCORE) return null;
    const picked: Section[] = [];
    let length = 0;
    for (const { section, score } of ranked.slice(0, MAX_SECTIONS)) {
      if (score < best * KEEP_RATIO) break;
      const size = section.title.length + section.text.length;
      if (picked.length > 0 && length + size > MAX_CHARS) break;
      picked.push(section);
      length += size;
    }
    return (
      "Knowledge base material for the person's last words; build on it where it bears on them.\n\n" +
      picked.map((s) => `## ${s.title}\n${s.text}`).join("\n\n")
    );
  };
}

const coachFiles = import.meta.glob("../../knowledge/coach/*.md", { query: "?raw", import: "default", eager: true });

export const coachKnowledge = createKnowledge(Object.values(coachFiles) as string[]);
