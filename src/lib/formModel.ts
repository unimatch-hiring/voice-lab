export type ClientProfile = {
  name: string;
  phone: string;
  car: string;
  plate: string;
  service: string;
  date: string;
};
export type Lang = "ru" | "en";
export type FormErrors = Partial<Record<keyof ClientProfile, string>>;

export const FIELDS = ["name", "phone", "car", "plate", "service", "date"] as const;
export const REQUIRED: readonly (keyof ClientProfile)[] = ["name", "phone", "car", "service"];

export const EMPTY_PROFILE: ClientProfile = { name: "", phone: "", car: "", plate: "", service: "", date: "" };

export const LABELS: Record<Lang, Record<keyof ClientProfile, string>> = {
  ru: { name: "Имя", phone: "Телефон", car: "Автомобиль", plate: "Госномер", service: "Услуга", date: "Дата визита" },
  en: { name: "Name", phone: "Phone", car: "Car", plate: "Plate number", service: "Service", date: "Visit date" },
};

export const CLEAR_PROFILE: Record<Lang, string> = { ru: "Очистить профиль", en: "Clear profile" };

const MSG = {
  ru: {
    required: "Обязательное поле",
    phone: "Телефон: от 10 до 15 цифр",
    plate: "Госномер: от 5 до 9 букв или цифр",
    date: "Дата в формате ГГГГ-ММ-ДД",
    past: "Эта дата уже прошла",
  },
  en: {
    required: "Required",
    phone: "Phone: 10 to 15 digits",
    plate: "Plate: 5 to 9 letters or digits",
    date: "Date as YYYY-MM-DD",
    past: "That date has already passed",
  },
};

export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Date rolls 2025-02-30 over to March; comparing the parts catches it.
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** True when a "YYYY-MM-DD[ HH:MM]" value is a day already gone, or a time already gone today. */
export function isPast(date: string, now: Date): boolean {
  const [day, time] = date.trim().split(/\s+/);
  if (!isIsoDate(day)) return false;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return day < today || (day === today && !!time && time <= `${pad(now.getHours())}:${pad(now.getMinutes())}`);
}

/**
 * Why the shop cannot take a "YYYY-MM-DD[ HH:MM]" value, or undefined when it can. The one
 * check for every way a date arrives: a tool argument, a read-back in digits or in words.
 */
export function dateRefusal(value: string, now: Date): "format" | "past" | "sunday" | undefined {
  const when = /^(\S+)(?: ([01]\d|2[0-3]):[0-5]\d)?$/.exec(value.trim());
  if (!when || !isIsoDate(when[1])) return "format";
  if (isPast(value, now)) return "past";
  // The prompt says Sunday is closed; a slot on one would contradict it.
  if (new Date(`${when[1]}T00:00Z`).getUTCDay() === 0) return "sunday";
}

export function validate(p: ClientProfile, lang: Lang, now = new Date()): FormErrors {
  const t = MSG[lang];
  const errors: FormErrors = {};
  for (const k of REQUIRED) if (!p[k].trim()) errors[k] = t.required;

  if (p.phone.trim()) {
    const digits = p.phone.replace(/[\s()+-]/g, "");
    if (!/^\d{10,15}$/.test(digits)) errors.phone = t.phone;
  }
  if (p.plate.trim() && !/^[\p{L}\p{N}]{5,9}$/u.test(p.plate.trim())) errors.plate = t.plate;
  // A booking writes the time after the date: "2026-11-17 10:30".
  const when = /^(\S+)(?: ([01]\d|2[0-3]):[0-5]\d)?$/.exec(p.date.trim());
  if (p.date.trim() && !(when && isIsoDate(when[1]))) errors.date = t.date;
  else if (p.date.trim() && isPast(p.date, now)) errors.date = t.past;
  return errors;
}

export function applyPatch(p: ClientProfile, patch: Partial<ClientProfile>): ClientProfile {
  const next = { ...p };
  for (const k of FIELDS) {
    const v = (patch as Record<string, unknown>)[k];
    if (typeof v === "string") next[k] = v.trim();
  }
  return next;
}

export function missingRequired(p: ClientProfile): (keyof ClientProfile)[] {
  return REQUIRED.filter((k) => !p[k].trim());
}

/** A stored profile back into shape: a corrupted or foreign record reads as empty, not as a crash. */
export function parseProfile(raw: string): ClientProfile {
  try {
    const data: unknown = JSON.parse(raw);
    return data && typeof data === "object" ? applyPatch(EMPTY_PROFILE, data) : EMPTY_PROFILE;
  } catch {
    return EMPTY_PROFILE;
  }
}

// Who the customer is is re-confirmed on every call; the booking is briefed separately.
const REMEMBERED = ["name", "phone", "car", "plate"] as const;

/** What earlier calls left on file, as a note for the agent; empty when nothing is known. */
export function briefing(p: ClientProfile): string {
  const known = REMEMBERED.filter((k) => p[k]).map((k) => `${k}: ${p[k]}`);
  // Without it the agent books a returning customer from scratch, as if nothing were on file.
  const booked = p.service && p.date ? `Booked on an earlier call: ${p.service} on ${p.date}. Mention it and ask whether to keep it, change it or book something else; do not book it again.` : "";
  // Taken on trust, a mis-heard phone from the last call would be booked again unchecked.
  return [
    known.length || booked ? "The customer has called before." : "",
    known.length ? `From earlier calls: ${known.join("; ")}. These are not confirmed for this call: read each one back and get a yes before using it.` : "",
    booked,
  ].filter(Boolean).join(" ");
}

/** The form as a text file, one labelled line per field, empty ones included so gaps show. */
export function formText(p: ClientProfile, lang: Lang): string {
  return FIELDS.map((k) => `${LABELS[lang][k]}: ${p[k]}`).join("\n") + "\n";
}
