/**
 * What the learner got wrong, as far as a rule can tell.
 *
 * Deliberately a table of narrow rules rather than a judgement. The agent corrects
 * out loud and does it far better than this ever will — it hears register, idiom and
 * what the learner meant. But a model's correction cannot be counted, listed on
 * screen, or asked about later, because nothing keeps it: this is the half that can
 * be, and the one the product promises when it says it remembers.
 *
 * ## The ceiling, stated plainly
 *
 * These rules catch the mistakes Russian speakers make often enough to be worth a
 * regular expression. They cannot catch "that is not how anyone says it", they
 * cannot tell a mistake from an ASR error — a transcript reading "I am agree" may be
 * a learner's slip or a recogniser's — and they will occasionally fire on a sentence
 * that was fine. So the log is a floor under the tutor's memory, never the whole
 * picture, and nothing here blocks or interrupts anything.
 *
 * A second LLM pass would do better and `findMistakes` is the seam for it: same
 * signature, same `Correction`, no other module would change.
 */

export interface Rule {
  id: string;
  /** Said out loud by nobody; it labels the count, as in "articles ×4". */
  label: string;
  find: RegExp;
  /** `$1`-style replacement, or a function for the irregular cases. */
  fix: string | ((...groups: string[]) => string);
}

export interface Correction {
  /** What the recogniser heard, as it heard it. */
  said: string;
  /** The same sentence with every rule that fired applied. */
  fixed: string;
  /** Which rules fired, so a count can be kept per rule. */
  ruleIds: string[];
}

/** Third person singular that is not simply `+s`. */
const IRREGULAR_S: Record<string, string> = {
  go: "goes", do: "does", have: "has", be: "is", watch: "watches",
  teach: "teaches", wash: "washes", study: "studies", fly: "flies", try: "tries",
};

function thirdPerson(verb: string): string {
  const lower = verb.toLowerCase();
  return IRREGULAR_S[lower] ?? `${lower}s`;
}

/** Verbs that take `to` + infinitive. */
const WANTS_TO =
  "like|likes|love|loves|hate|hates|want|wants|need|needs|try|tries|plan|plans|hope|hopes|decide|decides|learn|learns|start|starts|begin|begins|forget|forgets|promise|promises|would like";

/**
 * Bare infinitives that cannot also be the noun the trigger took as its object.
 *
 * Narrower than the list below, and found in review: "I need help", "I start work at
 * nine" and "the car needs work" are all correct English, and the wider list turned
 * each of them into a false correction with a count against the learner's name. What
 * is left is safe because the two words are adjacent — "I like watch" is never right,
 * while "I like my watch" never matches.
 */
const BARE_AFTER_TRIGGER =
  "listen|read|write|watch|go|do|make|eat|speak|learn|meet|buy|take|sing|understand";

/** After a pronoun, a noun reading is not available: "he work" wants "he works". */
const BARE_AFTER_PRONOUN =
  "listen|read|write|watch|play|go|do|make|eat|drink|study|work|travel|cook|swim|run|sleep|speak|talk|help|visit|drive|dance|sing|buy|take|walk|learn|live|meet";

/**
 * Words after which a bare infinitive is correct, so the third-person rule must not
 * fire. Found in review: without this, "did he go to school" came back as "did he
 * goes to school" and "let it go" as "let it goes".
 */
const TAKES_BARE = "do|does|did|will|wo|can|could|would|should|shall|may|might|must|let|lets|make|makes|made|help|helps|to|please";

/**
 * Narrow on purpose: every rule here is one a Russian speaker makes often and that a
 * regular expression can be sure of. A rule that needs to know what the sentence
 * means does not belong in this table.
 */
export const RULES: readonly Rule[] = [
  {
    id: "infinitive-to",
    label: "to + infinitive",
    find: new RegExp(`\\b(${WANTS_TO})\\s+(${BARE_AFTER_TRIGGER})\\b`, "gi"),
    fix: (_m, verb, next) => `${verb} to ${next}`,
  },
  {
    id: "listen-to",
    label: "listen to",
    // Matches the correct form too, and rewrites it to itself: an idempotent
    // replacement changes nothing, so "I listen to the radio" is not flagged, while
    // both "listen radio" and "listen to radio" are repaired.
    find: /\blisten\s+(?:to\s+)?(?:the\s+|a\s+|an\s+)?(radio|music|me|you|him|her|them|podcast|podcasts|news)\b/gi,
    // The replacement keeps the case it found. Returning lower case made a
    // sentence-initial "Listen to me" differ from itself, so a correct sentence was
    // logged, counted, and after three of them drilled.
    fix: (m, what) => {
      const verb = m[0] === m[0].toUpperCase() ? "Listen" : "listen";
      return /^(radio|news)$/i.test(what) ? `${verb} to the ${what}` : `${verb} to ${what}`;
    },
  },
  {
    id: "am-agree",
    label: "I agree",
    // The contracted forms have to keep the subject they are attached to. Replacing
    // the whole of "'m agree" with "agree" made "I'm agree" into "Iagree" — a
    // non-word, shown to the learner as the sentence English wants.
    find: /(\b(?:am|is|are)|'m|'re|'s)\s+agree\b/gi,
    fix: (_m, be) => {
      const verb = be === "is" || be === "'s" ? "agrees" : "agree";
      return be.startsWith("'") ? ` ${verb}` : verb;
    },
  },
  {
    id: "third-person-s",
    label: "he/she + verb-s",
    // Bare forms only. `has` and `is` belong to nobody's mistake, and listing them
    // here turned "she has two cats" into "she hass two cats".
    find: new RegExp(
      `(?<!\\b(?:${TAKES_BARE})\\s)\\b(he|she|it)\\s+(${BARE_AFTER_PRONOUN}|have|be|want|need|like|know|think|say|come|look|feel|get|give|tell|seem)\\b`,
      "gi",
    ),
    fix: (_m, who, verb) => `${who} ${thirdPerson(verb)}`,
  },
  {
    id: "uncountable",
    label: "uncountable nouns",
    find: /\b(informations|advices|moneys|knowledges|furnitures|homeworks|equipments|luggages|softwares)\b/gi,
    fix: (_m, word) => word.toLowerCase().replace(/s$/, ""),
  },
  {
    id: "double-comparative",
    label: "double comparative",
    find: /\b(more|most)\s+(better|easier|cheaper|worse|bigger|smaller|faster|harder|best|worst)\b/gi,
    fix: (_m, _more, adj) => adj.toLowerCase(),
  },
  {
    id: "how-called",
    label: "what is it called",
    // "it" is required in the last alternative. Optional, it matched "How do you call
    // a taxi in London" — correct English — and answered "What is it called a taxi in
    // London". The first two alternatives need no anchor: they are never right.
    find: /\bhow\s+(?:is\s+it\s+call(?:ed)?|it\s+(?:is\s+)?call(?:ed)?|do\s+you\s+call\s+it)\b/gi,
    fix: () => "what is it called",
  },
  {
    id: "feel-myself",
    label: "feel + adjective",
    // An adjective has to follow. "I don't feel myself today" is idiomatic English
    // for being unwell, and rewriting it to "I don't feel today" corrects a learner
    // who was right.
    find: /\bfeel\s+(?:myself|himself|herself|yourself|themselves)\s+(tired|bad|good|better|well|happy|sad|ill|sick|nervous|comfortable|uncomfortable|lonely|strange|fine|great|awful|guilty)\b/gi,
    fix: (_m, how) => `feel ${how}`,
  },
  {
    id: "since-for",
    label: "for + duration",
    find: /\bsince\s+(\d+|a|an|two|three|four|five|six|seven|eight|nine|ten)\s+(year|years|month|months|week|weeks|day|days|hour|hours)\b/gi,
    fix: (_m, howMany, unit) => `for ${howMany} ${unit}`,
  },
  {
    id: "in-the-picture",
    label: "in the picture",
    find: /\bon\s+(the|this|that)\s+(picture|photo|photograph|image)\b/gi,
    fix: (_m, which, what) => `in ${which} ${what}`,
  },
  {
    id: "take-a-photo",
    label: "take a photo",
    find: /\bmake\s+(a|the)\s+(photo|photos|picture|pictures|selfie)\b/gi,
    fix: (_m, article, what) => `take ${article} ${what}`,
  },
  {
    id: "interested-in",
    label: "interested in",
    find: /\b(am|is|are|'m|'re|'s)\s+interesting\s+in\b/gi,
    fix: (_m, be) => `${be} interested in`,
  },
  {
    id: "depend-on",
    label: "depend on",
    find: /\bdepends?\s+(?:of|from)\b/gi,
    fix: (m) => `${m.trim().split(/\s+/)[0]} on`,
  },
  {
    id: "different-from",
    label: "different from",
    find: /\bdifferent\s+(?:of|then)\b/gi,
    fix: () => "different from",
  },
];

/** Capitalised, because the corrected sentence is shown to a learner to read. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

/**
 * Every rule that fires, applied in order, as one corrected sentence.
 *
 * Cumulative rather than one mistake per rule: "i like listen radio" is two rules,
 * and a learner needs to see the sentence they should have said, not two fragments
 * of it. The rule ids are kept alongside so the count stays per rule.
 *
 * Returns `null` when nothing fired — which is the common case and means only that
 * no rule recognised anything, not that the sentence was right.
 */
export function findMistakes(text: string): Correction | null {
  const said = text.trim();
  if (!said) return null;

  let fixed = said;
  const ruleIds: string[] = [];
  for (const rule of RULES) {
    // `fix` is typed for both forms; the cast is the price of one table holding
    // plain replacements and functions side by side.
    const next = fixed.replace(rule.find, rule.fix as never);
    if (next !== fixed) {
      ruleIds.push(rule.id);
      fixed = next;
    }
  }

  if (ruleIds.length === 0) return null;

  const sentence = asSentence(fixed);
  // A rule can match correct English and rewrite it to itself — `listen-to` is built
  // that way on purpose. If the whole sentence came back the same but for its
  // capitalisation, nothing was corrected, whatever the rules claim.
  if (sentence.toLowerCase() === said.toLowerCase()) return null;

  return { said, fixed: sentence, ruleIds };
}

export function labelOf(ruleId: string): string {
  return RULES.find((r) => r.id === ruleId)?.label ?? ruleId;
}
