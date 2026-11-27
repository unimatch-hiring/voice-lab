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

const MSG = {
  ru: {
    required: "Обязательное поле",
    phone: "Телефон: от 10 до 15 цифр",
    plate: "Госномер: от 5 до 9 букв или цифр",
    date: "Дата в формате ГГГГ-ММ-ДД",
  },
  en: {
    required: "Required",
    phone: "Phone: 10 to 15 digits",
    plate: "Plate: 5 to 9 letters or digits",
    date: "Date as YYYY-MM-DD",
  },
};

function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Date rolls 2025-02-30 over to March; comparing the parts catches it.
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function validate(p: ClientProfile, lang: Lang): FormErrors {
  const t = MSG[lang];
  const errors: FormErrors = {};
  for (const k of REQUIRED) if (!p[k].trim()) errors[k] = t.required;

  if (p.phone.trim()) {
    const digits = p.phone.replace(/[\s()+-]/g, "");
    if (!/^\d{10,15}$/.test(digits)) errors.phone = t.phone;
  }
  if (p.plate.trim() && !/^[\p{L}\p{N}]{5,9}$/u.test(p.plate.trim())) errors.plate = t.plate;
  if (p.date.trim() && !isIsoDate(p.date.trim())) errors.date = t.date;
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

/** The fields already filled, as a note for the agent; empty when nothing is known. */
export function briefing(p: ClientProfile): string {
  const known = FIELDS.filter((k) => p[k]).map((k) => `${k}: ${p[k]}`);
  return known.length
    ? `Returning customer, already on file: ${known.join("; ")}. Greet them by name and do not ask for these again.`
    : "";
}

/** The form as a text file, one labelled line per field, empty ones included so gaps show. */
export function formText(p: ClientProfile, lang: Lang): string {
  return FIELDS.map((k) => `${LABELS[lang][k]}: ${p[k]}`).join("\n") + "\n";
}
