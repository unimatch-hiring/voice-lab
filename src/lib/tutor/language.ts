/**
 * Which language the learner just spoke, decided by script.
 *
 * Counted in words rather than characters on purpose. By character share, an
 * English sentence reaching for one Russian noun ("I like борщ") lands in the same
 * bucket as a sentence that is actually Russian, and the two call for opposite
 * responses: supply the missing word, or steer the lesson back.
 *
 * The agent is left multilingual for this to work at all. Forcing
 * `overrides.agent.language` to English would lock ASR to English, and a Russian
 * sentence would come back as mangled Latin rather than Cyrillic — the drift this
 * module exists to notice would become invisible. The agent answers in English
 * because the prompt says so, not because the transport forbids anything else.
 *
 * ## Forgive reluctantly
 *
 * The verdicts are not symmetric, and that is the design rather than an oversight.
 * `en` wipes the whole ladder, the offer to stop included; a wrongly counted slip
 * costs one gentle invitation that the learner's next English sentence undoes. So
 * English has to be *earned* — two real words of it — while a single Russian word
 * is taken at face value.
 *
 * That asymmetry is also what retired an arms race: an unlisted English filler
 * ("oh", "eh", "huh") used to pardon a four-turn run of Russian, and no list of
 * interjections could ever be complete enough to be relied on.
 */

export type Tongue = "en" | "ru" | "mixed" | "unknown";

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;

/**
 * Share of Russian words at which an utterance counts as Russian, and the share
 * under which it counts as English. Chosen, not measured: no recording of a
 * learner drifting mid-lesson exists yet. What would move them is a fixture from
 * `?record` showing how ASR actually renders a half-Russian sentence.
 */
const RUSSIAN_AT = 0.6;
const ENGLISH_UNDER = 0.2;

/**
 * Russian words that still read as an English utterance, when English words
 * outnumber them.
 *
 * A share alone is not enough. "I like борщ" is one third Russian, which at any
 * useful threshold is neither English nor Russian — and because `mixed` is inert, a
 * learner who came back to English but reached for one noun would keep the streak
 * they had already broken, and be escalated for it.
 *
 * The majority test is what keeps that from becoming an escape hatch: "нет, sorry"
 * is also one Russian word.
 */
const GAP_WORDS = 1;

/**
 * English words needed before an utterance can forgive a run of Russian. One is
 * not enough: "ok", "oh", "yes" are reflexes, not a decision to speak English, and
 * forgiving on one of them handed back the whole ladder for a grunt.
 */
const MIN_ENGLISH_WORDS = 2;

/** Below this a word is a breath, not evidence: "а" and "э" are what ASR invents. */
const MIN_WORD_LETTERS = 2;

/**
 * Sounds and reflexes, not words — in either script. A learner clearing their
 * throat is not choosing a language, and either verdict on one is wrong: `ru` tells
 * somebody who said "mm" that they spoke Russian, and `en` forgives Russian they
 * never stopped speaking.
 *
 * Written in canonical form: the lookup strips everything but letters and collapses
 * a repeated letter to two, so "э-э", "эээ" and "ЭЭ" all arrive here as "ээ".
 *
 * The Cyrillic entries at the end are English words as Russian ASR renders them —
 * "ок" is how a spoken "okay" usually comes back. Inert rather than English on
 * purpose: counting them as English would forgive a run on one syllable.
 */
const FILLERS = new Set([
  "мм", "эм", "ээ", "аа", "ээм", "ыы", "ну", "ага", "угу",
  "mm", "hmm", "hm", "um", "uh", "er", "erm", "ah", "oh", "eh", "huh", "mhm", "uhm",
  "ok", "okay", "yeah", "yep", "yup", "aha",
  "ок", "окей", "йес", "сорри", "плиз",
]);

/** Letters only, lower case, with runs of one letter collapsed to two. */
function canonical(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "")
    .replace(/(\p{L})\1+/gu, "$1$1");
}

/** A word belongs to whichever script more of its letters are in. */
function wordTongue(word: string): { tongue: "ru" | "en"; letters: number } | null {
  let cyr = 0;
  let lat = 0;
  for (const ch of word) {
    if (CYRILLIC.test(ch)) cyr++;
    else if (LATIN.test(ch)) lat++;
  }
  if (cyr === 0 && lat === 0) return null;
  return { tongue: cyr > lat ? "ru" : "en", letters: cyr + lat };
}

/**
 * `mixed` is deliberately inert further up: it is a vocabulary gap, not a refusal
 * to speak English, so it neither escalates the steering nor clears it. `unknown`
 * is the same inertness for the case where nothing judgeable was said at all.
 */
export function tongueOf(text: string): Tongue {
  let ru = 0;
  let en = 0;
  let substantive = 0;

  // Apostrophes and hyphens stay inside the word. Splitting on them turned "can't"
  // into two English words — enough to drag a plainly Russian sentence down to
  // `mixed`, where nothing is said about it — and "по-русски" into two Russian ones,
  // which stopped an English question about one Russian word from forgiving a run.
  for (const word of text.split(/[^\p{L}'’\-]+/u)) {
    const counted = wordTongue(word);
    if (counted === null || FILLERS.has(canonical(word))) continue;
    if (counted.letters >= MIN_WORD_LETTERS) substantive++;
    if (counted.tongue === "ru") ru++;
    else en++;
  }

  if (ru + en === 0 || substantive === 0) return "unknown";

  // Not enough English to be worth forgiving a run for. Russian is still Russian.
  if (en < MIN_ENGLISH_WORDS) {
    if (ru === 0) return "unknown";
    return en === 0 ? "ru" : "mixed";
  }

  if (ru === 0) return "en";
  if (ru <= GAP_WORDS) return "en";

  const share = ru / (ru + en);
  if (share >= RUSSIAN_AT) return "ru";
  if (share <= ENGLISH_UNDER) return "en";
  return "mixed";
}
