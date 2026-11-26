import { searchServices, serviceFact, SERVICES } from "./catalog";
import type { Confirmed } from "./confirmed";
import { applyPatch, dateRefusal, FIELDS, isIsoDate, isPast, missingRequired, validate, type ClientProfile } from "./formModel";
import type { ClientFunction } from "./pipeline/session";
import type { PipelineEvent } from "./types";

export interface ToolDeps {
  profile: () => ClientProfile;
  setProfile: (p: ClientProfile) => void;
  /** What the customer said yes to; update_form saves nothing else. */
  confirmed: Confirmed;
  /** Receives a `tool-result` with the facts each run handed the agent. */
  report?: (e: PipelineEvent) => void;
  /** The clock a past date is judged by; injectable so tests do not age. */
  now?: () => Date;
}

const HOURS = ["09:00", "10:30", "12:00", "14:00", "15:30", "17:00"];
const str = { type: "string" };

/** The agent's tools, one list for both engines. Bookings live for the page's lifetime. */
export function makeTools({ profile, setProfile, confirmed, report, now = () => new Date() }: ToolDeps): ClientFunction[] {
  const booked = new Set<string>();
  const json = (v: unknown) => JSON.stringify(v);
  const told = <T>(name: string, facts: unknown[], out: T): T => {
    report?.({ type: "tool-result", name, facts: facts.map(String) });
    return out;
  };

  /** Why nothing can happen on this date, for both the offer and the booking. */
  const closed = (date: unknown): string | undefined => {
    const why = isIsoDate(String(date)) ? dateRefusal(String(date), now()) : "format";
    return why && { format: "date must be YYYY-MM-DD", past: "date has passed", sunday: "closed on Sunday" }[why];
  };

  return [
    {
      name: "search_services",
      description: "Find car services, prices in rubles and duration by what the customer asks for.",
      parameters: { type: "object", properties: { query: str }, required: ["query"] },
      run: ({ query }) => {
        const found = searchServices(String(query ?? ""));
        return told("search_services", found.map(serviceFact), json(found.map(({ id, ru, en, price, minutes }) => ({ id, ru, en, price, minutes }))));
      },
    },
    {
      name: "find_slots",
      description: "Free start times on a date (YYYY-MM-DD).",
      parameters: { type: "object", properties: { date: str }, required: ["date"] },
      run: ({ date }) => {
        const refused = closed(date);
        if (refused) return told("find_slots", [], json({ error: refused }));
        // Today's earlier hours are gone as surely as yesterday is.
        const free = HOURS.filter((h) => !booked.has(`${date} ${h}`) && !isPast(`${date} ${h}`, now()));
        return told("find_slots", free.length ? [date, ...free] : [], json(free));
      },
    },
    {
      name: "book_appointment",
      description: "Book a confirmed service at a free time. Needs a name, a valid phone and a car in the form.",
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
        const refused = closed(date);
        if (refused) return json({ error: refused });
        if (missing.length) return json({ error: "form incomplete", missing });
        // Present is not enough: a phone of "123" reaches nobody.
        const invalid = Object.keys(validate({ ...profile(), service: service.ru, date: "" }, "en", now()));
        if (invalid.length) return json({ error: "form invalid", invalid });
        if (!HOURS.includes(String(time)) || booked.has(slot)) return json({ error: "slot not free" });
        if (isPast(slot, now())) return json({ error: "time has passed" });
        booked.add(slot);
        setProfile(applyPatch(profile(), { service: service.ru, date: slot }));
        return told("book_appointment", [serviceFact(service), date, time], json({ ok: true, service: service.ru, at: slot }));
      },
    },
    {
      name: "update_form",
      description: "Save form fields the customer has confirmed with a yes to your read-back. Any other value is refused.",
      parameters: { type: "object", properties: Object.fromEntries(FIELDS.map((k) => [k, str])) },
      run: (patch) => {
        const asked = FIELDS.filter((k) => typeof patch[k] === "string");
        const saved = asked.filter((k) => confirmed.has(k, patch[k] as string));
        const unconfirmed = asked.filter((k) => !saved.includes(k));
        if (saved.length) setProfile(applyPatch(profile(), Object.fromEntries(saved.map((k) => [k, patch[k]]))));
        // What the customer said counts as known too, or a phone read back digit by digit
        // would be flagged as a guess.
        const facts = saved.map((k) => profile()[k]);
        const missing = missingRequired(profile());
        return told(
          "update_form",
          facts,
          json(unconfirmed.length ? { ok: false, error: "not confirmed: read each back and wait for the customer's yes", unconfirmed, missing } : { ok: true, missing }),
        );
      },
    },
  ];
}
