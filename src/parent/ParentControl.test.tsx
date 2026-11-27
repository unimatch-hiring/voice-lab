import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ParentControl } from "./ParentControl";
import { AlertsPage } from "./AlertsPage";
import type { Child, ReviewAlert } from "../../shared/parent";

const id = "a789682b-f6cc-4687-bd23-0b4839927eea";
const serverUrl = "http://127.0.0.1:8788";
const profile: Child = {
  id, displayName: "Майя", age: null, note: "Любит космос.", ruleIds: [1], rulesVersion: 1,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("shows English loading and recovery messages", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockImplementation(async () => Response.json([]));
  render(<ParentControl serverUrl={serverUrl} fetchImpl={fetchImpl} />);

  expect(screen.getByRole("status").textContent).toBe("Loading profiles…");
  expect((await screen.findByRole("alert")).textContent)
    .toBe("Could not load profiles. Check that the server is running.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No profiles yet.");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("adds a reusable topic, creates a child with that topic, and confirms deletion", async () => {
  vi.stubEnv("BASE_URL", "/voice-lab/");
  const calls: [string, string, unknown][] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push([method, path, body]);
    if (path.endsWith("/alerts")) return Response.json({ items: [], nextCursor: null });
    if (method === "GET") return Response.json([]);
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/rules")) return Response.json({ id: 1, ...body }, { status: 201 });
    return Response.json({ ...body, id, rulesVersion: 1 }, { status: 201 });
  };
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<ParentControl serverUrl={serverUrl} fetchImpl={fetchImpl} />);

  expect(screen.getByRole("heading", { name: "Child profiles" })).toBeTruthy();
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Майя" } });
  fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Любит космос." } });
  fireEvent.change(screen.getByLabelText("New topic"), { target: { value: "Азартные игры" } });
  fireEvent.click(screen.getByRole("button", { name: "Add topic" }));
  const topic = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Азартные игры" });
  expect(topic.checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

  const link = await screen.findByRole("link", { name: new RegExp(id) });
  expect(screen.getByText("Child link")).toBeTruthy();
  const url = new URL(link.getAttribute("href")!);
  expect(url.pathname + url.search).toBe("/voice-lab/?child=" + id);
  expect(calls).toContainEqual(["POST", "/api/parent/children", {
    displayName: "Майя", age: null, note: "Любит космос.", ruleIds: [1],
  }]);
  fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
  expect(calls.some(([method]) => method === "DELETE")).toBe(false);
  expect(confirm).toHaveBeenCalledWith("Delete the profile for “Майя” and its history?");
  fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
  await screen.findByText("Profile deleted.");
  expect(calls).toContainEqual(["DELETE", "/api/parent/children/" + id, undefined]);
  expect(screen.queryByRole("button", { name: "Майя" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Азартные игры" })).toBeTruthy();
});

test("loads a selected child, keeps unsaved edits on failure, and retries the update", async () => {
  const posted: unknown[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/rules")) return Response.json([{ id: 1, label: "Азартные игры" }]);
    if (path.endsWith("/alerts")) return Response.json({ items: [], nextCursor: null });
    if (path.endsWith("/children")) return Response.json([
      { id, displayName: "Майя", age: null, unreadAlerts: 0 },
      { id: "alex", displayName: "Alex", age: null, unreadAlerts: 0 },
    ]);
    expect(path).toBe("/api/parent/children/" + id);
    if (init?.method !== "POST") return Response.json(profile);
    const body = JSON.parse(String(init.body));
    posted.push(body);
    if (posted.length === 1) return new Response(null, { status: 503 });
    return Response.json({ ...profile, ...body, rulesVersion: 2 });
  };
  render(<ParentControl serverUrl={serverUrl} fetchImpl={fetchImpl} />);
  const child = await screen.findByRole("button", { name: "Майя" });
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Alex", "Майя"]);
  fireEvent.click(child);
  const notes = await screen.findByDisplayValue<HTMLTextAreaElement>("Любит космос.");
  fireEvent.change(notes, { target: { value: "Любит поезда." } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "New profile" }));
  expect(confirm).toHaveBeenCalledWith("Switch profiles without saving your changes?");
  fireEvent.click(screen.getByRole("checkbox", { name: "Азартные игры" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not save the profile. Try again.");
  expect(notes.value).toBe("Любит поезда.");
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Азартные игры" }).checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Changes saved.");
  expect(posted).toEqual(Array(2).fill({ displayName: "Майя", age: null, note: "Любит поезда.", ruleIds: [] }));
});

test("shows alert evidence, marks only loaded cards, and updates the profile badge", async () => {
  vi.stubEnv("BASE_URL", "/voice-lab/");
  const alert: ReviewAlert = {
    turnId: "first-turn", childId: id, childName: "Майя", occurredAt: "2026-11-27T14:00:00.000Z",
    question: "Как устроены азартные игры?", seenAt: null, severity: 2,
    findings: [{
      kind: "forbidden_topic", rule: { id: 1, label: "Азартные игры" }, severity: 2,
      description: "The child asks about gambling.", evidence: { source: "input", quote: "азартные игры" },
    }],
  };
  const older: ReviewAlert = {
    ...alert, turnId: "second-turn", question: "Другой вопрос",
    findings: [{ ...alert.findings[0], description: "The child returns to the forbidden topic." }],
  };
  const seen = new Set<string>();
  const readBatches: string[][] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(String(url));
    if (pathname.endsWith("/children")) return Response.json([{ ...profile, unreadAlerts: 2 - seen.size }]);
    if (pathname.endsWith("/rules")) return Response.json([]);
    if (pathname.endsWith("/children/" + id)) return Response.json(profile);
    if (pathname.endsWith("/alerts/read")) {
      const { turnIds } = JSON.parse(String(init?.body));
      readBatches.push(turnIds);
      for (const turnId of turnIds) seen.add(turnId);
      return new Response(null, { status: 204 });
    }
    expect(pathname).toBe("/api/parent/alerts");
    expect(searchParams.get("childId")).toBe(id);
    const second = searchParams.get("cursor") === "page-two";
    const row = second ? older : alert;
    return Response.json({
      items: [{ ...row, seenAt: seen.has(row.turnId) ? row.occurredAt : null }],
      nextCursor: second ? null : "page-two",
    });
  };
  render(<ParentControl serverUrl={serverUrl} fetchImpl={fetchImpl} />);
  expect((await screen.findByRole("link", { name: "Alerts" })).getAttribute("href"))
    .toBe("/voice-lab/?alerts");
  await screen.findByLabelText("Unread alerts: 2");
  expect(readBatches).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: /Майя/ }));
  await screen.findByRole("heading", { name: alert.findings[0].description, level: 3 });
  expect(screen.queryByRole("heading", { name: alert.question })).toBeNull();
  expect(screen.getByText("Forbidden topic")).toBeTruthy();
  expect(screen.getByText(/“азартные игры”/)).toBeTruthy();
  expect(screen.getByText("Medium severity").getAttribute("data-severity")).toBe("2");
  await screen.findByLabelText("Unread alerts: 1");
  expect(readBatches).toEqual([["first-turn"]]);
  fireEvent.click(screen.getByRole("button", { name: "Show older alerts" }));
  await screen.findByRole("heading", { name: older.findings[0].description, level: 3 });
  await waitFor(() => expect(screen.queryByLabelText(/Unread alerts/)).toBeNull());
  expect(readBatches).toEqual([["first-turn"], ["second-turn"]]);
});

test("keeps the latest unread count when a previous refresh finishes late", async () => {
  const alert: ReviewAlert = {
    turnId: "newer", childId: id, childName: profile.displayName, occurredAt: "2026-11-27T14:00:00.000Z",
    question: "Test question", seenAt: null, severity: 2,
    findings: [{
      kind: "concern", severity: 2, description: "Test description",
      evidence: { source: "input", quote: "Test question" },
    }],
  };
  let resolveOldCounts: (response: Response) => void = () => {};
  const oldCounts = new Promise<Response>((resolve) => { resolveOldCounts = resolve; });
  let countRequests = 0;
  const fetchImpl: typeof fetch = async (url) => {
    const { pathname, searchParams } = new URL(String(url));
    if (pathname.endsWith("/children")) {
      countRequests += 1;
      if (countRequests === 2) return oldCounts;
      return Response.json([{ ...profile, unreadAlerts: countRequests === 1 ? 2 : 0 }]);
    }
    if (pathname.endsWith("/rules")) return Response.json([]);
    if (pathname.endsWith("/children/" + id)) return Response.json(profile);
    if (pathname.endsWith("/alerts/read")) return new Response(null, { status: 204 });
    return searchParams.has("cursor")
      ? Response.json({ items: [{ ...alert, turnId: "older" }], nextCursor: null })
      : Response.json({ items: [alert], nextCursor: "older" });
  };
  render(<ParentControl serverUrl={serverUrl} fetchImpl={fetchImpl} />);
  await screen.findByLabelText("Unread alerts: 2");
  fireEvent.click(screen.getByRole("button", { name: /Майя/ }));
  const more = await screen.findByRole<HTMLButtonElement>("button", { name: "Show older alerts" });
  await waitFor(() => expect(more.disabled).toBe(false));
  fireEvent.click(more);
  await waitFor(() => expect(screen.queryByLabelText(/Unread alerts/)).toBeNull());

  await act(async () => resolveOldCounts(Response.json([{ ...profile, unreadAlerts: 1 }])));
  expect(screen.queryByLabelText(/Unread alerts/)).toBeNull();
});

test("uses the shared parent layout and loads alerts directly without filters or reload controls", async () => {
  vi.stubEnv("BASE_URL", "/voice-lab-previews/pr-42/");
  const fetchImpl = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
  render(<AlertsPage serverUrl={serverUrl} fetchImpl={fetchImpl} />);
  const heading = screen.getByRole("heading", { name: "Alerts", level: 1 });
  expect(heading.closest(".masthead")).toBeTruthy();
  expect(heading.closest(".shell.parent-shell")).toBeTruthy();
  await screen.findByText("No alerts yet.");
  expect(screen.getByRole("link", { name: "Child profiles" }).getAttribute("href"))
    .toBe("/voice-lab-previews/pr-42/?parent=local-parent");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pathname: "/api/parent/alerts", search: "" }),
    expect.anything());
});

test("puts reasons in headings and highlights urgent alerts with a clear label", async () => {
  const alert: ReviewAlert = {
    turnId: "turn-a", childId: id, childName: "Майя", occurredAt: "2026-11-27T14:00:00.000Z",
    question: "Почему никто не хочет играть со мной?", seenAt: "2026-11-28T14:00:00.000Z", severity: 3,
    findings: [
      { kind: "concern", severity: 3, description: "The child says no one wants to play with them.",
        evidence: { source: "input", quote: "никто не хочет играть со мной" } },
      { kind: "forbidden_topic", severity: 2, description: "The agent suggests discussing betting, a forbidden topic.",
        evidence: { source: "output", quote: "Let's talk about betting." }, rule: { id: 1, label: "Betting" } },
    ],
  };
  const fetchImpl: typeof fetch = async () => Response.json({ items: [alert], nextCursor: null });
  render(<AlertsPage serverUrl={serverUrl} fetchImpl={fetchImpl} />);
  for (const finding of alert.findings) {
    expect((await screen.findByRole("heading", { name: finding.description, level: 2 })).closest("details")).toBeNull();
  }
  expect(screen.queryByRole("heading", { name: alert.question })).toBeNull();
  expect(screen.getByText(alert.question)).toBeTruthy();
  expect(screen.getByText("Майя")).toBeTruthy();
  expect(screen.getByText("Safety concern")).toBeTruthy();
  expect(screen.getByText("Forbidden topic")).toBeTruthy();
  expect(screen.getByText("Needs attention")).toBeTruthy();
  expect(screen.getByText("High severity")).toBeTruthy();
  expect(screen.getByText("Medium severity").getAttribute("data-severity")).toBe("2");
  expect(screen.getByText(/“никто не хочет играть со мной”/)).toBeTruthy();
  expect(screen.getByText(/“Let's talk about betting.”/)).toBeTruthy();
});
