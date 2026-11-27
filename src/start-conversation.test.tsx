import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { browserUserId } from "./lib/userId";
import type { SessionDeps } from "./lib/pipeline/session";

vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve("vibe_test"),
  saveToken: () => Promise.resolve(),
}));

vi.mock("./lib/userId", () => ({ browserUserId: vi.fn() }));

/** Sessions the page created, each with a start that finishes or fails only when the test says so. */
interface FakeSession {
  isRunning: boolean;
  /** What the page handed the session: the test plays the SDK by emitting on `deps.bus` and calling `deps.onEnded`. */
  deps: SessionDeps;
  finishStart: () => void;
  failStart: (error: unknown) => void;
  stop: ReturnType<typeof vi.fn>;
}
const created: FakeSession[] = [];

vi.mock("./lib/pipeline/createSession", () => ({
  createSession: (_engine: string, deps: SessionDeps) => {
    let finishStart = () => {};
    let failStart = (_error: unknown) => {};
    const session = {
      isRunning: false,
      deps,
      finishStart: () => finishStart(),
      failStart: (error: unknown) => failStart(error),
      mouthSpectrum: () => null,
      start: () =>
        new Promise<void>((resolve, reject) => {
          finishStart = () => {
            session.isRunning = true;
            resolve();
          };
          failStart = reject;
        }),
      stop: vi.fn(async () => {
        session.isRunning = false;
      }),
    };
    created.push(session);
    return session;
  },
}));

const USER_ID = "3f2b8c1e-5d4a-4b7e-9a60-1c2d3e4f5a6b";
const HISTORY_URL = "http://history.test";

beforeEach(() => {
  created.length = 0;
  vi.stubEnv("VITE_HISTORY_URL", HISTORY_URL);
  vi.mocked(browserUserId).mockReturnValue(USER_ID);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Answers history requests with `answer` and everything else with the default 404. */
function routeHistory(answer: () => Promise<Response>) {
  vi.mocked(fetch).mockImplementation((input) =>
    String(input).startsWith(HISTORY_URL) ? answer() : Promise.resolve(new Response("{}", { status: 404 })),
  );
}

/** Every request the page sent that is not for history, whatever the server address. */
function conversationRequests() {
  return vi.mocked(fetch).mock.calls.filter(([input]) => /\/conversations(\/|$)/.test(String(input)));
}

function historyRequests() {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith(HISTORY_URL));
}

const historyAccepts = () => Promise.resolve(new Response("{}", { status: 200 }));
const historyRefuses = () => Promise.resolve(new Response("{}", { status: 403 }));
const historyUnreachable = () => Promise.reject(new TypeError("Failed to fetch"));

/** The saved / not-saved line under the start button, null while it is not shown. */
function historyLine() {
  return document.querySelector(".history-line");
}

/** The start error under the button; empty when the conversation has no error. */
function conversationError() {
  return document.querySelector(".status-line")?.textContent ?? "";
}

/** Presses start and lets the fake session connect; fake timers begin once it runs. */
async function startConnectedConversation() {
  render(<App />);
  fireEvent.click(await startButton());
  await waitFor(() => expect(created).toHaveLength(1));
  await act(async () => created[0].finishStart());
  vi.useFakeTimers();
  return created[0];
}

/** What the SDK emits when the session connects. */
async function connect(session: FakeSession, conversationId = "conv_1") {
  await act(async () => {
    session.deps.bus.emit({
      type: "conversation-start",
      conversationId,
      agentId: "agent_1",
      at: performance.now(),
    });
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

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

test("a history server that is down does not stop or alter the conversation, and the visitor is told after 15 s", async () => {
  routeHistory(historyUnreachable);
  const session = await startConnectedConversation();
  await connect(session);
  expect(screen.getByRole("button", { name: /end conversation/i })).toBeTruthy();

  await act(async () => session.deps.onEnded("agent"));
  expect(screen.getByRole("button", { name: /start conversation/i })).toBeTruthy();
  expect(conversationError()).toBe("");

  await advance(14_000);
  expect(historyLine()?.textContent).toBe("Saving to history…");
  await advance(1_000);
  expect(historyLine()?.textContent).toMatch(/^This conversation was not saved to history\./);
  expect(historyLine()?.getAttribute("role")).toBe("status");
  expect(screen.getByRole("button", { name: /start conversation/i })).toBeTruthy();
  expect(conversationError()).toBe("");
});

test("when every entry is acknowledged the saved line shows the length and completed", async () => {
  routeHistory(historyAccepts);
  const session = await startConnectedConversation();
  await connect(session);
  await advance((6 * 60 + 48) * 1000);

  await act(async () => session.deps.onEnded("agent"));
  await advance(0);

  expect(historyLine()?.textContent).toBe("Saved to history — 6:48, completed. Open history");
  expect(historyLine()?.querySelector("a")?.getAttribute("href")).toBe("?history");
  expect(historyRequests().length).toBeGreaterThan(0);
});

test("an error ending is saved as failed with its message", async () => {
  routeHistory(historyAccepts);
  const session = await startConnectedConversation();
  await connect(session);
  await advance(5_000);

  await act(async () => session.deps.onEnded("error", "socket closed"));
  await advance(0);

  expect(historyLine()?.textContent).toBe("Saved to history — 0:05, failed — socket closed. Open history");
});

test("a refusal during the conversation shows the not-saved error at once while the conversation continues", async () => {
  routeHistory(historyRefuses);
  const session = await startConnectedConversation();

  await connect(session);
  await advance(0);

  // The server answered, so the line must not send the visitor off to start it.
  expect(historyLine()?.getAttribute("data-state")).toBe("notSaved");
  expect(historyLine()?.textContent).not.toContain("npm run server");
  expect(session.isRunning).toBe(true);
  expect(screen.getByRole("button", { name: /end conversation/i })).toBeTruthy();
  expect(conversationError()).toBe("");

  const requestsAfterRefusal = historyRequests().length;
  await act(async () => session.deps.bus.emit({ type: "agent-reply", text: "Hello there", at: performance.now() }));
  await advance(0);
  expect(historyRequests()).toHaveLength(requestsAfterRefusal);
});

test("a start that fails before connecting sends no history and shows only the microphone message", async () => {
  routeHistory(historyAccepts);
  render(<App />);
  fireEvent.click(await startButton());
  await waitFor(() => expect(created).toHaveLength(1));

  await act(async () => created[0].failStart(new DOMException("denied", "NotAllowedError")));

  expect(conversationError()).toMatch(/microphone is blocked/i);
  expect(historyLine()).toBeNull();
  expect(historyRequests()).toHaveLength(0);
});

test("without a user id nothing is sent to history and no line shows", async () => {
  vi.mocked(browserUserId).mockReturnValue(null);
  routeHistory(historyAccepts);
  const session = await startConnectedConversation();

  await connect(session);
  await act(async () => session.deps.onEnded("agent"));
  await advance(15_000);

  expect(historyRequests()).toHaveLength(0);
  expect(historyLine()).toBeNull();
});

test("End then Start on the same page continues the same conversation", async () => {
  // Server README: POST /conversations and POST /conversations/:id/entries answer 200.
  routeHistory(historyAccepts);
  const first = await startConnectedConversation();
  await connect(first);
  first.isRunning = false;
  await act(async () => first.deps.onEnded("agent"));
  await advance(0);
  expect(historyLine()?.textContent).toMatch(/^Saved to history/);

  fireEvent.click(screen.getByRole("button", { name: /start conversation/i }));
  await advance(0);
  await act(async () => created[1].finishStart());
  await connect(created[1], "conv_2");
  await advance(0);

  // A segment being recorded has no line, and nothing says "previous".
  expect(historyLine()).toBeNull();

  created[1].isRunning = false;
  await act(async () => created[1].deps.onEnded("agent"));
  await advance(0);

  const requestedUrls = historyRequests().map(([input]) => String(input));
  expect(requestedUrls.some((url) => url.includes("conv_2"))).toBe(false);
  const openedIds = historyRequests()
    .filter(([input]) => String(input) === `${HISTORY_URL}/conversations`)
    .map(([, init]) => JSON.parse(String(init?.body)).conversationId);
  expect(new Set(openedIds)).toEqual(new Set(["conv_1"]));
  const sentEndsAndResumes = historyRequests()
    .filter(([input]) => String(input) === `${HISTORY_URL}/conversations/conv_1/entries`)
    .flatMap(([, init]) => JSON.parse(String(init?.body)).entries)
    .filter((entry: { kind: string }) => entry.kind !== "line" && entry.kind !== "turn");
  expect(sentEndsAndResumes).toEqual([
    { kind: "end", endedBy: "agent", segment: 1 },
    { kind: "resume", segment: 2 },
    { kind: "end", endedBy: "agent", segment: 2 },
  ]);
  const lines = [...document.querySelectorAll(".history-line")].map((line) => line.textContent);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^Saved to history/);
  expect(lines[0]).not.toContain("Previous conversation");
});

test("on a published build with no history address a full conversation sends no history and shows no line", async () => {
  vi.stubEnv("VITE_HISTORY_URL", "");
  vi.stubEnv("DEV", false);
  vi.mocked(browserUserId).mockClear();
  routeHistory(historyAccepts);
  const session = await startConnectedConversation();

  await connect(session);
  await act(async () => session.deps.bus.emit({ type: "agent-reply", text: "Hello there", at: performance.now() }));
  await act(async () => session.deps.onEnded("agent"));
  await advance(15_000);

  expect(conversationRequests()).toHaveLength(0);
  expect(historyLine()).toBeNull();
  // Nothing is written to the visitor's storage for a feature the build does not have.
  expect(browserUserId).not.toHaveBeenCalled();
});

test("a development build with no history address sends history to the local server", async () => {
  vi.stubEnv("VITE_HISTORY_URL", "");
  vi.stubEnv("DEV", true);
  routeHistory(historyAccepts);
  const session = await startConnectedConversation();

  await connect(session);
  await act(async () => session.deps.onEnded("agent"));
  await advance(0);

  expect(conversationRequests().map(([input]) => String(input))).toContain("http://localhost:8788/conversations");
});

test("unmounting during a conversation sends its ending in a keepalive request before the session reports it", async () => {
  routeHistory(historyAccepts);
  const session = await startConnectedConversation();
  await connect(session);
  await advance(0);

  cleanup();

  const keepaliveRequests = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.keepalive === true);
  expect(keepaliveRequests).toHaveLength(1);
  expect(JSON.parse(String(keepaliveRequests[0][1]?.body)).entries).toEqual([{ kind: "end", endedBy: "user", segment: 1 }]);
});

test("hiding the page sends the lines still waiting for a retry and the closed ending in one keepalive request", async () => {
  let historyRequestCount = 0;
  routeHistory(() => (++historyRequestCount === 1 ? historyAccepts() : historyUnreachable()));
  const session = await startConnectedConversation();
  await connect(session);
  await act(async () => session.deps.bus.emit({ type: "agent-reply", text: "Hello there", at: performance.now() }));
  await advance(0);
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.keepalive === true)).toBe(false);

  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });

  const keepaliveRequests = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.keepalive === true);
  expect(keepaliveRequests).toHaveLength(1);
  expect(String(keepaliveRequests[0][0])).toBe(`${HISTORY_URL}/conversations/conv_1/entries`);
  expect(JSON.parse(String(keepaliveRequests[0][1]?.body)).entries).toEqual([
    expect.objectContaining({ kind: "line", seq: 1, speaker: "agent", text: "Hello there" }),
    { kind: "end", endedBy: "closed", segment: 1 },
  ]);
});
