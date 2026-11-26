import { expect, test } from "vitest";
import { EMPTY_PROFILE, type ClientProfile } from "./formModel";
import { makeConfirmed } from "./confirmed";
import { EventBus } from "./events";
import { supervise } from "./supervisor";
import { makeTools } from "./tools";
import { TOOL_NAMES } from "./persona";
import type { PipelineEvent } from "./types";

// Monday; the dates below are the days after it.
const NOW = new Date(2026, 10, 16, 12);

function harness(start: Partial<ClientProfile> = {}, now = NOW) {
  let p: ClientProfile = { ...EMPTY_PROFILE, ...start };
  const reported: PipelineEvent[] = [];
  const confirmed = makeConfirmed();
  const tools = makeTools({ profile: () => p, setProfile: (n) => (p = n), confirmed, report: (e) => reported.push(e), now: () => now });
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(await tools.find((t) => t.name === name)!.run(args));
  const facts = (name: string) =>
    reported.flatMap((e) => (e.type === "tool-result" && e.name === name ? e.facts : []));
  return { call, profile: () => p, setProfile: (n: ClientProfile) => (p = n), tools, facts, reported, confirmed };
}

test("every tool the prompt names exists", () => {
  expect(harness().tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
});

test("update_form fills the form and says what is still missing", async () => {
  const h = harness();
  h.confirmed.add({ name: "Анна", car: "Kia Rio" });
  const out = await h.call("update_form", { name: " Анна ", car: "Kia Rio", evil: "x" });

  expect(h.profile()).toMatchObject({ name: "Анна", car: "Kia Rio" });
  expect(out.missing).toEqual(["phone", "service"]);
});

test("search_services answers from the catalog", async () => {
  expect((await harness().call("search_services", { query: "замена масла" }))[0].id).toBe("oil");
});

test("a booking needs a complete form, and takes the slot", async () => {
  const h = harness({ name: "Анна", car: "Kia Rio" });
  const at = { service_id: "oil", date: "2026-11-17", time: "10:30" };

  expect(await h.call("book_appointment", at)).toMatchObject({ error: "form incomplete", missing: ["phone"] });

  h.confirmed.add({ phone: "89001234567" });
  await h.call("update_form", { phone: "+7 900 123-45-67" });
  expect(await h.call("book_appointment", at)).toMatchObject({ ok: true });
  expect(h.profile()).toMatchObject({ service: "Замена масла", date: "2026-11-17 10:30" });
  expect(await h.call("find_slots", { date: "2026-11-17" })).not.toContain("10:30");
  expect(await h.call("book_appointment", at)).toMatchObject({ error: "slot not free" });
});

test("each tool reports the facts it handed the agent", async () => {
  const h = harness({ name: "Анна", car: "Kia Rio" });
  await h.call("search_services", { query: "замена масла" });
  await h.call("find_slots", { date: "2026-11-17" });
  h.confirmed.add({ phone: "89001234567" });
  await h.call("update_form", { phone: "+7 900 123-45-67" });
  await h.call("book_appointment", { service_id: "oil", date: "2026-11-17", time: "10:30" });

  expect(h.facts("search_services")).toEqual(["Замена масла, Oil change: 2500 ₽, 30 min"]);
  expect(h.facts("find_slots")).toEqual(expect.arrayContaining(["2026-11-17", "10:30", "17:00"]));
  expect(h.facts("update_form")).toEqual(["+7 900 123-45-67"]);
  expect(h.facts("book_appointment")).toEqual(["Замена масла, Oil change: 2500 ₽, 30 min", "2026-11-17", "10:30"]);
});

test("a search that finds nothing still reports the call, with no facts", async () => {
  const h = harness();
  await h.call("search_services", { query: "покраска крыши" });
  expect(h.reported).toEqual([{ type: "tool-result", name: "search_services", facts: [] }]);
});

test("find_slots offers nothing on a Sunday or a malformed date", async () => {
  const h = harness();
  expect(await h.call("find_slots", { date: "2026-11-22" })).toEqual({ error: "closed on Sunday" });
  expect(await h.call("find_slots", { date: "завтра" })).toEqual({ error: "date must be YYYY-MM-DD" });
  expect(h.facts("find_slots")).toEqual([]);
});

test("a date already gone is neither offered nor booked", async () => {
  const h = harness({ name: "Анна", phone: "89001234567", car: "Kia Rio" });
  expect(await h.call("find_slots", { date: "2026-11-13" })).toEqual({ error: "date has passed" });
  expect(await h.call("book_appointment", { service_id: "oil", date: "2026-11-13", time: "10:30" })).toEqual({ error: "date has passed" });
  expect(h.profile().date).toBe("");
});

test("a booking is refused on a Sunday or a date that is not YYYY-MM-DD, like the slots are", async () => {
  const h = harness({ name: "Анна", phone: "89001234567", car: "Kia Rio" });
  expect(await h.call("book_appointment", { service_id: "oil", date: "2026-11-22", time: "10:30" })).toEqual({ error: "closed on Sunday" });
  expect(await h.call("book_appointment", { service_id: "oil", date: "tomorrow", time: "10:30" })).toEqual({ error: "date must be YYYY-MM-DD" });
  expect(h.profile()).toMatchObject({ service: "", date: "" });
});

test("a time already gone today is neither offered nor booked", async () => {
  const h = harness({ name: "Анна", phone: "89001234567", car: "Kia Rio" }, new Date(2026, 10, 16, 16));
  expect(await h.call("find_slots", { date: "2026-11-16" })).toEqual(["17:00"]);
  expect(await h.call("book_appointment", { service_id: "oil", date: "2026-11-16", time: "10:30" })).toEqual({ error: "time has passed" });
  expect(h.profile().date).toBe("");
  expect(await h.call("book_appointment", { service_id: "oil", date: "2026-11-16", time: "17:00" })).toMatchObject({ ok: true });
});

test("a phone that is present but not a phone does not book", async () => {
  const h = harness({ name: "Анна", phone: "123", car: "Kia Rio" });
  expect(await h.call("book_appointment", { service_id: "oil", date: "2026-11-17", time: "10:30" })).toEqual({ error: "form invalid", invalid: ["phone"] });
  expect(h.profile().date).toBe("");
  expect(h.facts("book_appointment")).toEqual([]);
});

test("update_form saves only what the customer said yes to in a read-back", async () => {
  const h = harness();
  const bus = new EventBus();
  supervise({ bus, profile: h.profile, setProfile: h.setProfile, send: () => {}, confirmed: h.confirmed });
  const say = (text: string) => bus.emit({ type: "stt-result", result: { text, words: [] } });

  expect(await h.call("update_form", { phone: "+7 900 123-45-67", name: "Анна" })).toMatchObject({ ok: false, unconfirmed: ["name", "phone"] });
  expect(h.profile()).toEqual(EMPTY_PROFILE);
  expect(h.facts("update_form")).toEqual([]);

  bus.emit({ type: "agent-reply", text: "Записываю телефон: +7 900 123-45-67. Верно?", at: 0 });
  say("нет");
  expect(await h.call("update_form", { phone: "+7 900 123-45-67" })).toMatchObject({ ok: false });
  expect(h.profile().phone).toBe("");

  bus.emit({ type: "agent-reply", text: "Записываю телефон: +7 900 123-45-67. Верно?", at: 0 });
  say("да");
  // The same number in another spelling is the confirmed one; the name is still only heard.
  expect(await h.call("update_form", { phone: "8 (900) 123-45-67", name: "Анна" })).toMatchObject({ ok: false, unconfirmed: ["name"] });
  expect(h.profile()).toMatchObject({ phone: "8 (900) 123-45-67", name: "" });
});
