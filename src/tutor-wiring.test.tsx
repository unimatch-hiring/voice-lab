import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { App } from "./App";
import type { StoredLesson } from "./lib/tutor/lessonStore";

/**
 * The tutor reaches the agent only if App actually subscribes it to the bus. Every
 * other test here is of a pure function, and all of them stayed green with the
 * wiring deleted — which is the one thing CLAUDE.md forbids a suite to do.
 *
 * So this drives the whole chain through the real App: the SDK reports what the
 * learner said, the bus carries it, the reducer judges it, and the directive comes
 * back out at the SDK.
 */

vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve("vibe_test"),
  saveToken: () => Promise.resolve(),
}));

// jsdom has no IndexedDB, so the lesson store is faked — and faking it is also how a
// previous visit is staged.
let stored: StoredLesson = { mistakes: [], counts: {}, rechecked: [] };
vi.mock("./lib/tutor/lessonStore", () => ({
  loadLesson: () => Promise.resolve(stored),
  saveLesson: (lesson: StoredLesson) => {
    stored = lesson;
    return Promise.resolve();
  },
}));

/** The SDK callbacks App handed over, so a transcript can be delivered by hand. */
let handlers: Record<string, (arg?: unknown) => void> = {};
let contextSent: string[] = [];
let startOptions: Record<string, unknown> = {};

vi.mock("@elevenlabs/client", () => ({
  Conversation: {
    startSession: async (opts: Record<string, unknown>) => {
      startOptions = opts;
      handlers = {};
      for (const [key, value] of Object.entries(opts)) {
        if (typeof value === "function") handlers[key] = value as () => void;
      }
      return {
        endSession: async () => {},
        sendContextualUpdate: (text: string) => contextSent.push(text),
        getOutputVolume: () => 0,
        getOutputByteFrequencyData: () => new Uint8Array(1024),
      };
    },
  },
}));

beforeEach(() => {
  contextSent = [];
  handlers = {};
  startOptions = {};
  stored = { mistakes: [], counts: {}, rechecked: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ token: "t", agentId: "a" }))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Starts a conversation the way a visitor does.
 *
 * Waits for the button to flip rather than for the callbacks to appear: App flips it
 * only after `session.start()` has resolved, which is when the conversation handle
 * exists. Waiting on `handlers.onMessage` instead cannot tell the second handshake
 * from the first — the callbacks are still those of session one — so a transcript
 * could arrive while the handle was null and the directive be dropped. With a
 * zero-delay fetch stub that passed anyway; with 5 ms it did not.
 */
async function startTalking() {
  const start = await screen.findByRole("button", { name: /start conversation/i });
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  handlers = {};
  fireEvent.click(start);
  await screen.findByRole("button", { name: /end conversation/i });
  await waitFor(() => expect(handlers.onMessage).toBeTypeOf("function"));
}

test("a learner drifting into Russian is steered, end to end through the page", async () => {
  render(<App />);
  await startTalking();

  handlers.onMessage?.({ message: "I cooked pasta yesterday", source: "user" } as never);
  expect(
    contextSent.filter((t) => /spoke Russian/.test(t)),
    "English needs no steering",
  ).toEqual([]);

  handlers.onMessage?.({ message: "дальше давай по-русски", source: "user" } as never);

  await waitFor(() =>
    expect(contextSent.filter((t) => /spoke Russian/.test(t))).toHaveLength(1),
  );
  const steering = contextSent.find((t) => /spoke Russian/.test(t))!;
  expect(steering).toMatch(/^\[TUTOR DIRECTIVE\]/);
  expect(steering).toMatch(/English/);
});

test("a second conversation does not inherit the first learner's streak", async () => {
  render(<App />);
  await startTalking();

  handlers.onMessage?.({ message: "по-русски давай", source: "user" } as never);
  handlers.onMessage?.({ message: "нет, по-русски", source: "user" } as never);
  const steering = () => contextSent.filter((text) => /Russian/.test(text));
  await waitFor(() => expect(steering()).toHaveLength(2));

  // End it, then start again: this is a new lesson, and without the reset the rule
  // gets stated to a learner who was never invited back.
  fireEvent.click(screen.getByRole("button", { name: /end conversation/i }));
  await startTalking();

  handlers.onMessage?.({ message: "опять по-русски", source: "user" } as never);

  await waitFor(() => expect(steering()).toHaveLength(3));
  expect(steering()[2], "back to the gentle rung").toBe(steering()[0]);
});

test("a mistake travels from the recogniser to the board on the page", async () => {
  // The board is wired to the same bus the tutor emits on. Without that line in App
  // the lesson still runs and nothing ever appears on screen.
  render(<App />);
  await startTalking();

  handlers.onMessage?.({ message: "i like listen radio", source: "user" } as never);

  const log = (await screen.findByLabelText(
    /mistakes and their corrections/i,
  )) as HTMLTextAreaElement;
  await waitFor(() =>
    expect(log.value).toBe("i like listen radio -> I like to listen to the radio"),
  );
  // And the agent is handed the same record, so it can answer about it out loud.
  expect(contextSent.some((t) => t.includes("I like to listen to the radio"))).toBe(true);
});

test("editing the token does not wipe what the learner got wrong", async () => {
  // Found in review: the tutor was rebuilt with the session, which React rebuilds when
  // the config changes. The log restarted at zero while the board kept its lines, so
  // the counter disagreed with the list beneath it.
  render(<App />);
  await startTalking();

  handlers.onMessage?.({ message: "she have two cats", source: "user" } as never);
  const log = (await screen.findByLabelText(
    /mistakes and their corrections/i,
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(log.value).toContain("She has two cats"));

  // Re-paste the token, which is what rebuilds the session.
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  fireEvent.click(screen.getByRole("button", { name: /forget token/i }));
  await screen.findByLabelText(/access token/i);

  handlers.onMessage?.({ message: "he go to work", source: "user" } as never);
  await waitFor(() => expect(log.value.split("\n")).toHaveLength(2));
  expect(screen.getByText("2"), "the count still matches the list").toBeTruthy();
});

test("the level the learner gave survives a reload, and is not asked for again", async () => {
  render(<App />);
  await startTalking();

  handlers.onMessage?.({ message: "my level is intermediate", source: "user" } as never);
  await waitFor(() => expect(screen.getByText("B1")).toBeTruthy());
  expect(screen.getByText(/you said so/i)).toBeTruthy();

  // Reload: a new App against the store the last one wrote.
  cleanup();
  contextSent = [];
  render(<App />);

  await waitFor(() => expect(screen.getByText("B1")).toBeTruthy());
  await startTalking();
  handlers.onMessage?.({ message: "I went to the park", source: "user" } as never);
  expect(
    contextSent.filter((t) => /what their level/i.test(t)),
    "a known level is not asked about again",
  ).toEqual([]);
});

test("a remembered level is in the session handshake before the first reply", async () => {
  stored = {
    level: { level: "B2", source: "told" },
    mistakes: [],
    counts: {},
    rechecked: [],
  };

  render(<App />);
  await waitFor(() => expect(screen.getByText("B2")).toBeTruthy());
  await startTalking();

  const prompt = (startOptions.overrides as { agent?: { prompt?: { prompt?: string } } })
    ?.agent?.prompt?.prompt;
  expect(prompt).toContain("KNOWN LEARNER LEVEL");
  expect(prompt).toContain("B2");
  expect(prompt).toMatch(/do not ask for it again/i);
  expect(contextSent.filter((text) => /Ask the learner what their level/i.test(text))).toEqual([]);
});

test("a new learner is asked their level through the live conversation", async () => {
  render(<App />);
  await startTalking();

  expect(contextSent.filter((text) => /Ask the learner what their level/i.test(text))).toHaveLength(1);
  const prompt = (startOptions.overrides as { agent?: { prompt?: { prompt?: string } } })
    ?.agent?.prompt?.prompt;
  expect(prompt).toContain("LEVEL STATUS");
});

test("resetting the level asks again, and the mistakes stay", async () => {
  stored = {
    level: { level: "B2", source: "told" },
    mistakes: [
      { said: "she have two cats", fixed: "She has two cats", ruleIds: ["third-person-s"] },
    ],
    counts: { "third-person-s": 1 },
    rechecked: [],
  };

  render(<App />);
  await startTalking();
  const log = (await screen.findByLabelText(
    /mistakes and their corrections/i,
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(log.value).toContain("She has two cats"));

  fireEvent.click(await screen.findByRole("button", { name: /reset level/i }));

  await waitFor(() => expect(screen.getByText(/not set/i)).toBeTruthy());
  expect(
    contextSent.some((t) => /cleared their level/i.test(t)),
    "the agent is told to ask again now, not next session",
  ).toBe(true);
  expect(log.value, "the record is not what was reset").toContain("She has two cats");
  expect(stored.level, "and the reset is written down").toBeUndefined();
});

test("clearing the mistakes empties the box and the store, and keeps the level", async () => {
  stored = {
    level: { level: "B2", source: "told" },
    mistakes: [
      { said: "she have two cats", fixed: "She has two cats", ruleIds: ["third-person-s"] },
    ],
    counts: { "third-person-s": 1 },
    rechecked: [],
  };

  render(<App />);
  const log = (await screen.findByLabelText(
    /mistakes and their corrections/i,
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(log.value).toContain("She has two cats"));
  await startTalking();

  fireEvent.click(await screen.findByRole("button", { name: /^clear$/i }));

  await waitFor(() => expect(log.value).toBe(""));
  // Scoped to this panel: the waterfall has a readout of its own that also says 0.
  expect(screen.getByText(/corrected/i).textContent, "the counter goes with it").toMatch(
    /corrected\s*0/,
  );
  expect(stored.mistakes, "and the store is emptied").toEqual([]);
  expect(stored.level, "the level is not what was cleared").toEqual({
    level: "B2",
    source: "told",
  });
  expect(
    contextSent.some((t) => /cleared their record/i.test(t)),
    "the agent is told to stop referring to them",
  ).toBe(true);
});
