import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";

vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve("vibe_test"),
  saveToken: () => Promise.resolve(),
}));

/** Sessions the page created, each with a start that finishes only when the test says so. */
interface FakeSession {
  isRunning: boolean;
  finishStart: () => void;
  stop: ReturnType<typeof vi.fn>;
}
const created: FakeSession[] = [];

vi.mock("./lib/pipeline/createSession", () => ({
  createSession: () => {
    let finishStart = () => {};
    const session = {
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

beforeEach(() => {
  created.length = 0;
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
