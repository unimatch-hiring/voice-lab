/**
 * Phrases that send a message for review. Broad on purpose: matching by substring catches
 * Russian word forms and over-matches, and the review on the server sorts out the noise.
 */
export const DEFAULT_TRIGGERS = [
  // ru — stems, so every word form matches
  "убить", "убью", "убил", "умер", "смерт", "суицид", "покончить", "не хочу жить",
  "порез", "бьет", "бьют", "бил", "ударил", "трогает", "трогал", "раздева",
  "секрет", "тайн", "никому не говори", "боюсь", "страшно", "обижа", "травл",
  // en
  "kill", "die", "dead", "suicide", "hurt", "cut myself", "hit", "touch",
  "secret", "don't tell", "scared", "afraid", "bully",
];

const normalize = (s: string) => s.toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").trim();

/** The parent's free-form field: one phrase per line or separated by commas. */
export function parseTriggerWords(text: string): string[] {
  return text
    .split(/[\n,;]/)
    .map(normalize)
    .filter(Boolean);
}

/** Every alarm phrase found in the message, default ones and the parent's. */
export function findTriggers(text: string, extra: string[] = []): string[] {
  const haystack = normalize(text);
  const phrases = new Set([...DEFAULT_TRIGGERS, ...extra].map(normalize));
  return [...phrases].filter((p) => p && haystack.includes(p));
}
