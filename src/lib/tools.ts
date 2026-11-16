import { searchServices, SERVICES } from "./catalog";
import { applyPatch, FIELDS, missingRequired, type ClientProfile } from "./formModel";
import type { ClientFunction } from "./pipeline/session";
import type { PipelineEvent } from "./types";

export interface ToolDeps {
  profile: () => ClientProfile;
  setProfile: (p: ClientProfile) => void;
  /** Receives a `tool-result` with the facts each run handed the agent. */
  report?: (e: PipelineEvent) => void;
}

const HOURS = ["09:00", "10:30", "12:00", "14:00", "15:30", "17:00"];
const str = { type: "string" };

/** The agent's tools, one list for both engines. Bookings live for the page's lifetime. */
export function makeTools({ profile, setProfile, report }: ToolDeps): ClientFunction[] {
  const booked = new Set<string>();
  const json = (v: unknown) => JSON.stringify(v);
  const told = <T>(name: string, facts: unknown[], out: T): T => {
    if (facts.length) report?.({ type: "tool-result", name, facts: facts.map(String) });
    return out;
  };

  return [
    {
      name: "search_services",
      description: "Find car services, prices in rubles and duration by what the customer asks for.",
      parameters: { type: "object", properties: { query: str }, required: ["query"] },
      run: ({ query }) => {
        const found = searchServices(String(query ?? "")).map(({ id, ru, en, price, minutes }) => ({ id, ru, en, price, minutes }));
        return told("search_services", found.flatMap((s) => [s.ru, s.en, s.price, s.minutes]), json(found));
      },
    },
    {
      name: "find_slots",
      description: "Free start times on a date (YYYY-MM-DD).",
      parameters: { type: "object", properties: { date: str }, required: ["date"] },
      run: ({ date }) => {
        const free = HOURS.filter((h) => !booked.has(`${date} ${h}`));
        return told("find_slots", free.length ? [date, ...free] : [], json(free));
      },
    },
    {
      name: "book_appointment",
      description: "Book a confirmed service at a free time. Needs name, phone and car in the form.",
      parameters: {
        type: "object",
        properties: { service_id: str, date: str, time: str },
        required: ["service_id", "date", "time"],
      },
      run: ({ service_id, date, time }) => {
        const service = SERVICES.find((s) => s.id === service_id);
        const slot = `${date} ${time}`;
        const missing = missingRequired({ ...profile(), service: service?.ru ?? "" });
        if (!service) return json({ error: "unknown service_id" });
        if (missing.length) return json({ error: "form incomplete", missing });
        if (!HOURS.includes(String(time)) || booked.has(slot)) return json({ error: "slot not free" });
        booked.add(slot);
        setProfile(applyPatch(profile(), { service: service.ru, date: slot }));
        return told("book_appointment", [service.ru, service.en, service.price, date, time], json({ ok: true, service: service.ru, at: slot }));
      },
    },
    {
      name: "update_form",
      description: "Fill or correct fields of the customer form as soon as the customer mentions them.",
      parameters: { type: "object", properties: Object.fromEntries(FIELDS.map((k) => [k, str])) },
      run: (patch) => {
        setProfile(applyPatch(profile(), patch));
        // What the customer said counts as known too, or a phone read back digit by digit
        // would be flagged as a guess.
        const facts = FIELDS.filter((k) => k in patch).map((k) => profile()[k]).filter(Boolean);
        return told("update_form", facts, json({ ok: true, missing: missingRequired(profile()) }));
      },
    },
  ];
}
