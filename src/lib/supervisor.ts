import { applyPatch, missingRequired, validate, type ClientProfile } from "./formModel";
import type { Confirmed } from "./confirmed";
import type { EventBus } from "./events";
import { accepts, readBacks } from "./readBack";

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
const ASKS_NAME = /как\s+(?:к\s+вам\s+обращаться|вас\s+зовут)|what(?:'s| is)\s+your\s+name|who\s+am\s+I\s+speaking/iu;
const NOT_A_NAME = new Set(["да", "нет", "не", "знаю", "я", "меня", "зовут", "привет", "здравствуйте", "алло", "yes", "no", "hi", "hello", "i", "im", "it", "is", ...FILLER]);

function findPlate(text: string): string | undefined {
  for (const m of text.matchAll(PLATE)) {
    const raw = m[1];
    if (/\s/.test(raw) && UNIT_PAIR.test(raw.replace(/[\s\d]/g, "").slice(1))) continue;
    return raw;
  }
}

// "I'm looking for…" is not a name; a capital is what the transcript gives a name.
const IM = /(?<![\p{L}])I(?:'|’)?m\s+(\p{Lu}\p{Ll}+)(?![\p{L}])/u;

const NOT_NAMES = new Set(["not", "sure", "sorry", "fine", "just", "here", "calling", "interested", "afraid", "trying", "ok", "okay"]);

function findName(text: string): string | undefined {
  const lead = NAME_LEAD.exec(text);
  if (!lead) {
    const im = IM.exec(text)?.[1];
    return im && !NOT_NAMES.has(im.toLowerCase()) ? im : undefined;
  }
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

/** "Сергей" said alone, right after the agent asked for the name. */
function bareName(text: string): string | undefined {
  const words = (text.match(/[\p{L}-]+/gu) ?? []).filter((w) => !NOT_A_NAME.has(w.toLowerCase().replace(/'/g, "")));
  // A sentence is not a name; a short answer is.
  if (words.length < 1 || words.length > 2 || words[0].length < 2) return undefined;
  return words[0][0].toUpperCase() + words[0].slice(1);
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

// Driving on is the risk with these; the prompt says so too, this catches the turn it forgets.
const UNSAFE: [string, RegExp][] = [
  ["brakes not working", /тормоз\p{L}*\s+(?:не\s+работа|отказ)|отказал\p{L}*\s+тормоз|нет\s+тормоз|brakes?\s+(?:do\s*n.?t|not|failed)|no brakes/iu],
  ["smoke from the engine", /дым|smok/iu],
  ["smell of fuel", /пахн\p{L}*\s+бензин|запах\p{L}*\s+бензин|smell\p{L}*\s+(?:of\s+)?(?:fuel|petrol|gas)/iu],
  ["steering heavy or locked", /рул\p{L}*\s+(?:заклин|тяж|не\s+повора)|steering\b.*\b(?:heavy|locked|stiff)/iu],
];
const CLAIMS_BOOKED =
  /вы\s+записаны|запись\s+(?:подтверждена|оформлена)|я\s+(?:вас\s+)?записал|you(?:'re| are)\s+(?:all\s+)?(?:booked|set)\b|(?:booking|appointment)\s+is\s+(?:confirmed|made|booked)/iu;

const GOODBYE = /до\s+свидания|всего\s+(?:доброго|хорошего)|хорошего\s+дня|до\s+встречи|goodbye|bye\b|have\s+a\s+(?:good|nice|great)\s+day/iu;

interface Deps {
  bus: EventBus;
  profile: () => ClientProfile;
  setProfile: (p: ClientProfile) => void;
  send: (text: string) => void;
  /** Ends the call from our side; the agent has no end_call tool on the dashboard. */
  hangUp?: () => void;
  /** Filled on each yes, for update_form to check against. */
  confirmed?: Confirmed;
}

const squash = (s: string) => s.replace(/\s/g, "").toUpperCase().replace(/[A-Z]/g, (c) => CYRILLIC[c] ?? c);

/** True when the agent's reply repeats a value the customer said, in whatever wording. */
function echoes(reply: string, field: keyof ClientProfile, value: string): boolean {
  // "+7 900…" and "8 900…" are one number: the last ten digits are what has to come back.
  if (field === "phone") return reply.replace(/\D/g, "").includes(value.replace(/\D/g, "").slice(-10));
  if (field === "plate") return squash(reply).includes(value);
  // The ending varies with the case: "Анну" is still "Анна".
  return reply.toLowerCase().includes(value.toLowerCase().slice(0, Math.max(3, value.length - 1)));
}

/**
 * Fills the form from values the customer said yes to — the agent's read-backs, or the customer's
 * own words once the agent repeats them — and steers the model with what is left. Works whether
 * or not the model ever calls update_form.
 */
export function supervise({ bus, profile, setProfile, send, hangUp, confirmed }: Deps): () => void {
  // A yes from an earlier call confirms nothing in this one.
  confirmed?.clear();
  let last: string | null = null;
  // The value just read back waits for the customer's yes; a mis-heard read-back never reaches the form.
  let pending: Partial<ClientProfile> | null = null;
  // What the customer said themselves; speech recognition mis-hears too, so it waits for the same yes.
  let said: Partial<ClientProfile> = {};
  // When ElevenLabs streams a reply, its final agent-reply is not emitted; the tokens are the reply.
  let streamed = "";
  // The answer to "как к вам обращаться?" is often the bare name, which no phrase pattern catches.
  let askedName = false;
  // After the closing hint, the reply that says goodbye is the last; the line drops once it is heard.
  let closed = false;
  let farewell = false;
  let hungUp = false;
  // A full form is not a booking; only the tool's own success is, or one recorded on an earlier call.
  const start = profile();
  let booked = !!start.date.trim() && !nudge(start);
  const sent = new Set<string>();
  // The same hint twice reads to the model as insistence.
  const hint = (key: string, text: string) => {
    if (!sent.has(key)) send(text);
    sent.add(key);
  };

  const reply = (text: string) => {
    streamed = "";
    if (closed && GOODBYE.test(text)) farewell = true;
    askedName = ASKS_NAME.test(text);
    const heard = readBacks(text);
    const fields = Object.keys(heard) as (keyof ClientProfile)[];
    // Two read-backs in one breath leave a lone "да" ambiguous, so neither is taken on it.
    pending = fields.length === 1 ? heard : null;
    if (!fields.length) {
      const echoed = (Object.keys(said) as (keyof ClientProfile)[]).filter((k) => echoes(text, k, said[k]!));
      if (echoed.length === 1) pending = { [echoed[0]]: said[echoed[0]] };
    }
    if (fields.length > 1) hint(`two:${text}`, "Read back one value per turn and wait for the customer's answer.");
    if (CLAIMS_BOOKED.test(text) && !booked) {
      const missing = missingRequired(profile()).join(", ");
      hint(`claim:${missing}`, `Nothing is booked yet: book_appointment has not succeeded. Correct yourself, then ${missing ? `ask for what the form is still missing (${missing})` : "agree a free time and call book_appointment"}.`);
    }
  };

  const caseKey = (p: ClientProfile) => `done:${p.name}|${p.phone}|${p.car}|${p.service}|${p.date}`;
  // A booking already on file when the call starts is the briefing's to raise, not a reason to hang up.
  const onFile = caseKey(profile());
  // Without a word that the case is closed the model keeps asking, round and round.
  const closeIfComplete = () => {
    const p = profile();
    if (!p.date.trim() || nudge(p) || caseKey(p) === onFile) return;
    closed = true;
    // The closing hint itself says the booking is recorded, so the agent repeating it is not a false claim.
    booked = true;
    hint(
      caseKey(p),
      `The booking is recorded: ${p.service} for ${p.name}, ${p.car}, on ${p.date}, phone ${p.phone}. Tell the customer in one sentence what they are booked for, say goodbye, and ask nothing more.`,
    );
  };

  const off = bus.on((e) => {
    if (e.type === "llm-token") streamed += e.token;
    else if (e.type === "stage-start" && e.stage === "capture") {
      // Capture reopens only once the reply has finished playing, so the goodbye is not cut off.
      if (streamed.trim()) reply(streamed);
      if (farewell && !hungUp && hangUp) {
        hungUp = true;
        hangUp();
      }
    }
    else if (e.type === "agent-reply") reply(e.text);
    else if (e.type === "tool-result") booked ||= e.name === "book_appointment";
    else if (e.type === "stt-result") {
      const text = e.result.text;
      if (streamed.trim()) reply(streamed);
      if (pending && accepts(text, Object.keys(pending)[0] as keyof ClientProfile)) {
        setProfile(applyPatch(profile(), pending));
        confirmed?.add(pending);
        for (const k of Object.keys(pending)) delete said[k as keyof ClientProfile];
      }
      pending = null;
      const found = extractFields(text);
      if (askedName && !found.name) found.name = bareName(text);
      askedName = false;
      for (const k of Object.keys(found) as (keyof ClientProfile)[]) {
        const v = found[k];
        if (!v) delete found[k];
        // Only a read-back and a yes fill the form, so the agent is told to do it now, not later.
        else if (profile()[k] !== v) hint(`readback:${k}:${v}`, `The customer just gave the ${k}: ${v}. Read it back next, in the prescribed shape, before asking anything else.`);
      }
      said = { ...said, ...found };
      for (const [label, cue] of UNSAFE) {
        if (cue.test(text)) hint(`unsafe:${label}`, `The customer described "${label}". Before anything else, tell them not to drive the car and to call a tow truck.`);
      }
    } else if (e.type === "profile-cleared") {
      // A yes after Clear would otherwise bring the old value straight back.
      pending = null;
      said = {};
      streamed = "";
      last = null;
      confirmed?.clear();
    } else if (e.type === "turn-end") {
      const text = nudge(profile());
      // Once per change: repeating the same nudge every turn only makes the agent nag.
      if (text && text !== last) send(text);
      last = text;
    }
    if (e.type === "stt-result" || e.type === "tool-result") closeIfComplete();
  });
  return off;
}
