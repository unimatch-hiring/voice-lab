import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChildProfile } from "../shared/child";
import { App } from "./App";
import type { Engine } from "./lib/pipeline/session";

vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve("vibe_test"),
  saveToken: () => Promise.resolve(),
}));

/** Sessions the page created, each with a start that finishes only when the test says so. */
interface FakeSession {
  engine: Engine;
  isRunning: boolean;
  finishStart: (running?: boolean) => void;
  stop: ReturnType<typeof vi.fn>;
}
const created: FakeSession[] = [];
const childId = "a789682b-f6cc-4687-bd23-0b4839927eea";
const childProfile: ChildProfile = {
  displayName: "Maya",
  prompt: "Use planets as examples.",
  rulesVersion: 1,
};

vi.mock("./lib/pipeline/createSession", () => ({
  createSession: (engine: Engine) => {
    let finishStart = (_running?: boolean) => {};
    const session = {
      engine,
      isRunning: false,
      finishStart: (running?: boolean) => finishStart(running),
      mouthSpectrum: () => null,
      start: () =>
        new Promise<void>((resolve) => {
          finishStart = (running = true) => {
            session.isRunning = running;
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
  vi.unstubAllEnvs();
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

test("forgetting the token during engine selection cancels the pending start", async () => {
  render(<App />);
  const button = await startButton();
  let finishEngine!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finishEngine = resolve; }));

  fireEvent.click(screen.getByRole("button", { name: "settings" }));
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "Forget token" }));
  await screen.findByLabelText(/access token/i);
  await act(async () => finishEngine(Response.json({ engine: "elevenlabs" })));

  expect(created).toHaveLength(0);
});

function mockChildRequests(profile = childProfile, engine: Engine = "elevenlabs") {
  vi.stubEnv("VITE_CHILD_LLM_URL", "http://127.0.0.1:8788");
  vi.stubEnv("VITE_WORKER_URL", "https://worker.test");
  vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith("/engine")
    ? Response.json({ engine }) : Response.json(profile));
}

test("a child link shows the name and opens a call on the engine assigned to its interview key", async () => {
  mockChildRequests(childProfile, "deepgram");
  render(<App childId={childId} />);

  await screen.findByRole("heading", { name: "voice-lab · Maya" });
  expect(screen.getByText("A voice conversation page for Maya.")).toBeTruthy();
  expect(created).toHaveLength(0);

  fireEvent.click(await startButton());
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0].engine).toBe("deepgram");
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
    "http://127.0.0.1:8788/profile?childId=" + childId,
    "https://worker.test/engine",
  ]));
});

test("a child call that has already disconnected does not leave the button in call mode", async () => {
  mockChildRequests();
  render(<App childId={childId} />);
  fireEvent.click(await startButton());
  await waitFor(() => expect(created).toHaveLength(1));
  await act(async () => created[0].finishStart(false));
  expect(screen.getByRole("button", { name: "Start conversation" }).hasAttribute("disabled")).toBe(false);
});
