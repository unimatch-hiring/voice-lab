import { expect, test } from "vitest";
import { EMPTY_PROFILE, type ClientProfile } from "./formModel";
import { makeTools } from "./tools";
import { TOOL_NAMES } from "./persona";
import type { PipelineEvent } from "./types";

function harness(start: Partial<ClientProfile> = {}) {
  let p: ClientProfile = { ...EMPTY_PROFILE, ...start };
  const reported: PipelineEvent[] = [];
  const tools = makeTools({ profile: () => p, setProfile: (n) => (p = n), report: (e) => reported.push(e) });
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(await tools.find((t) => t.name === name)!.run(args));
  const facts = (name: string) =>
    reported.flatMap((e) => (e.type === "tool-result" && e.name === name ? e.facts : []));
  return { call, profile: () => p, tools, facts };
}

test("every tool the prompt names exists", () => {
  expect(harness().tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
});

test("update_form fills the form and says what is still missing", async () => {
  const h = harness();
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
  await h.call("update_form", { phone: "+7 900 123-45-67" });
  await h.call("book_appointment", { service_id: "oil", date: "2026-11-17", time: "10:30" });

  expect(h.facts("search_services")).toEqual(expect.arrayContaining(["Замена масла", "Oil change", "2500", "30"]));
  expect(h.facts("find_slots")).toEqual(expect.arrayContaining(["2026-11-17", "10:30", "17:00"]));
  expect(h.facts("update_form")).toEqual(["+7 900 123-45-67"]);
  expect(h.facts("book_appointment")).toEqual(expect.arrayContaining(["Замена масла", "2026-11-17", "10:30"]));
});

test("a search that finds nothing reports no facts", async () => {
  const h = harness();
  await h.call("search_services", { query: "покраска крыши" });
  expect(h.facts("search_services")).toEqual([]);
});
