export interface Service {
  id: string;
  ru: string;
  en: string;
  /** Rubles. */
  price: number;
  minutes: number;
  /** Words customers use instead of the name, in either language. */
  aka: string[];
}

export const SERVICES: Service[] = [
  { id: "oil", ru: "Замена масла", en: "Oil change", price: 2500, minutes: 30, aka: ["масло", "фильтр", "oil", "filter"] },
  { id: "brakes", ru: "Замена тормозных колодок", en: "Brake pad replacement", price: 4000, minutes: 60, aka: ["тормоза", "колодки", "скрипит", "brakes", "pads", "squeak"] },
  { id: "tires", ru: "Шиномонтаж", en: "Tire change", price: 3000, minutes: 45, aka: ["шины", "колеса", "резина", "колесо", "tires", "wheels"] },
  { id: "diag", ru: "Компьютерная диагностика", en: "Computer diagnostics", price: 1500, minutes: 30, aka: ["ошибка", "чек", "лампа", "check", "engine", "light", "error"] },
  { id: "align", ru: "Развал-схождение", en: "Wheel alignment", price: 2800, minutes: 60, aka: ["развал", "уводит", "тянет", "alignment", "pulls"] },
  { id: "ac", ru: "Заправка кондиционера", en: "A/C recharge", price: 3500, minutes: 40, aka: ["кондиционер", "кондей", "холодит", "conditioner", "ac", "cooling"] },
];

// A crude stem: Russian endings vary ("масло", "масла", "шина", "шины"), so words match on
// their first letters, at most four and never the last one.
const stem = (w: string) => (w.length <= 3 ? w : w.slice(0, Math.min(4, w.length - 1)));

// Verbs every request shares ("заменить шины", "change oil") would otherwise tie unrelated services.
const STOP = new Set(["заме", "поме", "пере", "сдел", "нужн", "хоч", "chan", "repl", "need", "want"]);

const stems = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\ba\/c\b/g, "ac")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2)
    .map(stem)
    .filter((w) => !STOP.has(w));

const INDEX = SERVICES.map((s) => ({ s, stems: new Set(stems([s.ru, s.en, ...s.aka].join(" "))) }));

/** Services ranked by how many of the query's words they match; none when nothing does. */
export function searchServices(query: string): Service[] {
  const q = stems(query);
  return INDEX.map(({ s, stems }) => ({ s, hits: q.filter((w) => stems.has(w)).length }))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((r) => r.s);
}
