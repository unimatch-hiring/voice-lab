import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { EMPTY_PROFILE, type ClientProfile } from "./lib/formModel";
import type { SessionDeps } from "./lib/pipeline/session";

// jsdom has no IndexedDB, so the store is faked; what matters is what the page reads and writes.
let stored: ClientProfile = EMPTY_PROFILE;
let token = "";
vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve(token),
  saveToken: () => Promise.resolve(),
  loadProfile: () => Promise.resolve(stored),
  saveProfile: (p: ClientProfile) => {
    stored = p;
    return Promise.resolve();
  },
}));

// The session is faked down to the deps it was given, so a tool call can be made by hand.
let deps: SessionDeps | null = null;
let sent: string[] = [];
let starting: Promise<void> = Promise.resolve();
vi.mock("./lib/pipeline/createSession", () => ({
  createSession: (_: unknown, d: SessionDeps) => {
    deps = d;
    return {
      isRunning: true,
      mouthSpectrum: () => null,
      start: () => starting,
      stop: async () => {},
      sendContextualUpdate: (t: string) => sent.push(t),
    };
  },
}));

beforeEach(() => {
  token = "";
  deps = null;
  sent = [];
  starting = Promise.resolve();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
  stored = { ...EMPTY_PROFILE, name: "Анна", car: "Kia Rio" };
});

// The button is on screen before the stored token loads, and a click on it while disabled is lost.
async function startConversation() {
  const start = await screen.findByRole("button", { name: /start conversation/i });
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(deps).not.toBeNull());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("after a reload the form comes back filled from the store", async () => {
  render(<App />);

  await waitFor(() => expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("Анна"));
  expect((screen.getByLabelText(/Car/) as HTMLInputElement).value).toBe("Kia Rio");
});

test("every edit is written to the store, so the next reload sees it", async () => {
  render(<App />);
  await waitFor(() => expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("Анна"));

  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: "+7 900 123-45-67" } });

  expect(stored).toEqual({ ...EMPTY_PROFILE, name: "Анна", car: "Kia Rio", phone: "+7 900 123-45-67" });
});

test("the agent's update_form lands in the form on screen and in the store", async () => {
  token = "vibe_test";
  render(<App />);
  await startConversation();

  const run = (name: string, args: Record<string, unknown>) =>
    deps!.functions!.find((f) => f.name === name)!.run(args);
  await act(async () => {
    await run("update_form", { phone: "+7 900 123-45-67" });
    await run("update_form", { plate: "А123ВС77" });
  });

  expect((screen.getByLabelText(/Phone/) as HTMLInputElement).value).toBe("+7 900 123-45-67");
  expect(stored).toMatchObject({ name: "Анна", phone: "+7 900 123-45-67", plate: "А123ВС77" });
});

test("what the customer says reaches the form even when the agent calls no tool", async () => {
  token = "vibe_test";
  render(<App />);
  await startConversation();

  act(() => deps!.bus.emit({ type: "stt-result", result: { text: "телефон 89001234567", words: [] } }));

  await waitFor(() => expect((screen.getByLabelText(/Phone/) as HTMLInputElement).value).toBe("89001234567"));
  expect(stored.phone).toBe("89001234567");
});

test("the agent is told at start what the store already knows about the customer", async () => {
  token = "vibe_test";
  render(<App />);
  await waitFor(() => expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("Анна"));
  await startConversation();

  expect(deps!.briefing!()).toMatch(/Анна.*Kia Rio/);
});

test("the form on screen is in English whatever language the agent speaks", async () => {
  render(<App />);
  await waitFor(() => expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Анна"));
  expect(screen.getByLabelText(/^Phone/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: "123" } });

  expect(screen.getByRole("alert").textContent).toBe("Phone: 10 to 15 digits");
});

// The stored profile lacks phone and service, so every turn-end has a nudge to send.
const endTurn = () => act(() => deps!.bus.emit({ type: "turn-end", at: 0, metrics: {} as never }));

test("nothing is sent to a conversation the user has ended", async () => {
  token = "vibe_test";
  render(<App />);
  await startConversation();
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  fireEvent.click(await screen.findByRole("button", { name: /end conversation/i }));
  await screen.findByRole("button", { name: /start conversation/i });
  const before = sent.length;

  endTurn();

  expect(sent).toHaveLength(before);
});

test("nothing is sent to a conversation the agent has hung up", async () => {
  token = "vibe_test";
  render(<App />);
  await startConversation();
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  act(() => deps!.onEnded("agent"));
  const before = sent.length;

  endTurn();

  expect(sent).toHaveLength(before);
});

test("nothing is sent once the page is gone", async () => {
  token = "vibe_test";
  const { unmount } = render(<App />);
  await startConversation();
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  const bus = deps!.bus;
  unmount();
  const before = sent.length;

  bus.emit({ type: "turn-end", at: 0, metrics: {} as never });

  expect(sent).toHaveLength(before);
});

test("a conversation torn down while starting is never supervised", async () => {
  token = "vibe_test";
  let open = () => {};
  starting = new Promise((r) => (open = r));
  const { unmount } = render(<App />);
  await startConversation();
  const bus = deps!.bus;
  unmount();
  await act(async () => open());

  bus.emit({ type: "turn-end", at: 0, metrics: {} as never });

  expect(sent).toEqual([]);
});
