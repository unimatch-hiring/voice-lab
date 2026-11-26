import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { EMPTY_SETTINGS, type ParentSettings } from "./lib/parental/types";
import type { SessionDeps } from "./lib/pipeline/session";

vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve("vibe_test"),
  saveToken: () => Promise.resolve(),
}));

/** Sessions the page created, each with a start that finishes only when the test says so. */
interface FakeSession {
  isRunning: boolean;
  finishStart: () => void;
  stop: ReturnType<typeof vi.fn>;
  deps: SessionDeps;
}
const created: FakeSession[] = [];

vi.mock("./lib/pipeline/createSession", () => ({
  createSession: (_engine: string, deps: SessionDeps) => {
    let finishStart = () => {};
    const session = {
      deps,
      isRunning: false,
      finishStart: () => finishStart(),
      mouthSpectrum: () => null,
      start: () =>
        new Promise<void>((resolve) => {
          finishStart = () => {
            session.isRunning = true;
            resolve();
          };
        }),
      stop: vi.fn(async () => {
        session.isRunning = false;
      }),
    };
    created.push(session);
    return session;
  },
}));

const parent = vi.hoisted(() => ({ getSettings: vi.fn<() => Promise<ParentSettings>>() }));
vi.mock("./lib/parental/parentApi", () => ({ createParentApi: () => parent }));

beforeEach(() => {
  created.length = 0;
  parent.getSettings.mockResolvedValue(EMPTY_SETTINGS);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function startButton() {
  const button = await screen.findByRole("button", { name: /start conversation/i });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  return button;
}

test("a second press while starting does not open a second paid session", async () => {
  render(<App />);
  const button = await startButton();

  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(created).toHaveLength(1));
  fireEvent.click(button);
  await act(async () => created[0].finishStart());

  expect(created).toHaveLength(1);
});

test("the start button is disabled while a session is starting", async () => {
  render(<App />);
  const button = await startButton();

  fireEvent.click(button);
  await waitFor(() => expect(created).toHaveLength(1));

  expect(button.hasAttribute("disabled")).toBe(true);
});

test("a session still starting when the page goes away is closed once it opens", async () => {
  const { unmount } = render(<App />);
  fireEvent.click(await startButton());
  await waitFor(() => expect(created).toHaveLength(1));

  unmount();
  await act(async () => created[0].finishStart());

  expect(created[0].isRunning).toBe(false);
});

test("the conversation opens with what the parent set", async () => {
  parent.getSettings.mockResolvedValue({
    ...EMPTY_SETTINGS,
    childProfile: "Masha, 7, loves drawing",
    blockedTopics: "horror films",
  });
  render(<App />);
  fireEvent.click(await startButton());

  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0].deps.prompt).toContain("Masha, 7, loves drawing");
  expect(created[0].deps.prompt).toContain("horror films");
});

test("without the parent's settings no conversation starts", async () => {
  parent.getSettings.mockRejectedValue(new Error("server down"));
  render(<App />);
  fireEvent.click(await startButton());

  expect(await screen.findByText(/settings could not be loaded/i)).toBeTruthy();
  expect(created).toHaveLength(0);
});
