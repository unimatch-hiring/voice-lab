import { applyPatch, FIELDS, missingRequired, validate, type ClientProfile } from "./formModel";
import type { EventBus } from "./events";

const L = "АВЕКМНОРСТУХABEKMHOPCTYX";
// \b is ASCII-only in JS even with /u, so Cyrillic plates need explicit edges.
const PLATE = new RegExp(`(?<![\\p{L}\\p{N}])([${L}]\\s?\\d{3}\\s?[${L}]{2}\\s?\\d{2,3})(?![\\p{L}\\p{N}])`, "giu");
// Spoken distances, times and sums fit the plate shape once spaced out: "в 150 км 30 минут".
const UNIT_PAIR = /^(?:КМ|KM|СМ|CM|ММ|MM|ТР|TP)$/iu;
const CYRILLIC = Object.fromEntries([..."ABEKMHOPCTYX"].map((c, i) => [c, "АВЕКМНОРСТУХ"[i]]));
// Russian numbers only: +7/8/7 and ten digits, or a bare ten-digit 9xx. Not preceded by another
// number group, so a list of sums never reads as a phone; the fixed length keeps a following
// date or price off the end of it.
const PHONE = /(?<!\d[\s()-]*)((?:\+7|8|7)(?:[\s()-]{0,2}\d){10}|9(?:[\s()-]{0,2}\d){9})(?!\d)/u;
const NAME_LEAD = /(?:меня зовут|my name is)\s+/iu;
// "не Анна, а Мария" — the negated word is skipped along with the particle.
const NEGATION = new Set(["не", "not"]);
const FILLER = new Set(["это", "ну", "а", "вот", "but", "uh", "um"]);

function findPlate(text: string): string | undefined {
  for (const m of text.matchAll(PLATE)) {
    const raw = m[1];
    if (/\s/.test(raw) && UNIT_PAIR.test(raw.replace(/[\s\d]/g, "").slice(1))) continue;
    return raw;
  }
}

function findName(text: string): string | undefined {
  const lead = NAME_LEAD.exec(text);
  if (!lead) return;
  const words = text.slice(lead.index + lead[0].length).match(/[\p{L}-]+/gu) ?? [];
  let i = 0;
  while (i < words.length) {
    const w = words[i].toLowerCase();
    if (NEGATION.has(w)) i += 2;
    else if (FILLER.has(w)) i += 1;
    else break;
  }
  const name = words[i];
  return name && name.length >= 2 ? name[0].toUpperCase() + name.slice(1) : undefined;
}

/** What the customer just said that belongs in the form, read straight off the transcript. */
export function extractFields(text: string): Partial<ClientProfile> {
  const out: Partial<ClientProfile> = {};
  const plate = findPlate(text);
  // The plate is cut out first: its digits would otherwise read as part of a phone number.
  const rest = plate ? text.replace(plate, " ") : text;
  const phone = PHONE.exec(rest)?.[1];
  if (phone) out.phone = phone;
  if (plate) out.plate = plate.replace(/\s/g, "").toUpperCase().replace(/[A-Z]/g, (c) => CYRILLIC[c] ?? c);
  const name = findName(text);
  if (name) out.name = name;
  return out;
}

/** What the model still has to ask for, or null when the form is complete and valid. */
export function nudge(p: ClientProfile): string | null {
  const missing = missingRequired(p);
  const invalid = Object.keys(validate(p, "en")).filter((k) => !missing.includes(k as keyof ClientProfile));
  if (!missing.length && !invalid.length) return null;
  return [
    missing.length && `Form still missing: ${missing.join(", ")}. Ask for one of them next.`,
    invalid.length && `These look wrong, confirm them: ${invalid.join(", ")}.`,
  ].filter(Boolean).join(" ");
}

interface Deps {
  bus: EventBus;
  profile: () => ClientProfile;
  setProfile: (p: ClientProfile) => void;
  send: (text: string) => void;
}

/**
 * Fills the form from what the customer says and steers the model with what is left.
 * Works whether or not the model ever calls update_form.
 */
export function supervise({ bus, profile, setProfile, send }: Deps): () => void {
  const known = FIELDS.filter((k) => profile()[k]).map((k) => `${k}: ${profile()[k]}`);
  if (known.length) send(`Returning customer, already on file: ${known.join("; ")}. Do not ask again.`);
  let last: string | null = null;
  return bus.on((e) => {
    if (e.type === "stt-result") {
      const patch = extractFields(e.result.text);
      if (Object.keys(patch).length) setProfile(applyPatch(profile(), patch));
    } else if (e.type === "turn-end") {
      const text = nudge(profile());
      // Once per change: repeating the same nudge every turn only makes the agent nag.
      if (text && text !== last) send(text);
      last = text;
    }
  });
}
