import { Conversation } from "@elevenlabs/client";
import { afterEach, expect, test, vi } from "vitest";
import { AgentSession } from "./agentSession";
import { EventBus } from "../events";
import { SYSTEM_PROMPT } from "../persona";
import { Recorder } from "../recorder";
import type { PipelineEvent, TurnMetrics } from "../types";
import type { TurnReview } from "../../../shared/child";
import { TurnModel } from "../../scene/turnModel";

/** Captures the callbacks the SDK would have received, so they can be fired by hand. */
const handlers: Record<string, (arg?: unknown) => void> = {};
/** What the session asked the SDK for, so the handshake itself can be asserted on. */
let startOptions: Record<string, unknown> = {};
const childId = "a789682b-f6cc-4687-bd23-0b4839927eea";
const workerToken = "worker-session-token";
const conversationId = "d00e62fc-3e94-4625-ace8-73895af44eb6";
const profile = {
  displayName: "Maya",
  prompt: "Use planets as examples.\n\nReply in English.\n",
  rulesVersion: 2,
};

vi.mock("@elevenlabs/client", () => ({
  Conversation: {
    startSession: async (opts: Record<string, unknown>) => {
      startOptions = opts;
      for (const [key, value] of Object.entries(opts)) {
        if (typeof value === "function") handlers[key] = value as () => void;
      }
      return {
        endSession: async () => {},
        getOutputVolume: () => 0,
        getOutputByteFrequencyData: () => new Uint8Array(1024),
      };
    },
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeSession(childProfile = vi.fn(async () => profile), childId?: string) {
  const bus = new EventBus();
  const events: PipelineEvent[] = [];
  bus.on((e) => events.push(e));

  const turns: TurnMetrics[] = [];
  const reviewTurn = vi.fn<(review: TurnReview) => Promise<void>>(async () => {});
  const endChildConversation = vi.fn(async () => {});
  const agentToken = vi.fn(async () => ({ token: workerToken, agentId: "a" }));
  const startChildConversation = vi.fn(async () => ({ conversationId }));

  const session = new AgentSession({
    bus,
    childId,
    transport: {
      childProfile, agentToken, startChildConversation, reviewTurn, endChildConversation,
    } as never,
    onTurn: (m) => turns.push(m),
    onEnded: () => {},
  });

  return { session, bus, events, turns, childProfile, agentToken, startChildConversation, reviewTurn, endChildConversation };
}

async function harness() {
  const h = makeSession();
  await h.session.start();
  return h;
}

const lanes = (events: PipelineEvent[], type: "stage-start" | "stage-end") =>
  events.filter((e) => e.type === type).map((e) => (e as { stage: string }).stage);

test("the model's stage is reported", async () => {
  // `Mode` is only "speaking" | "listening" — there is no "thinking". Mapping the absent
  // third value to `llm` left the lane permanently empty and `metrics.stages.llm` unset,
  // which is the one number this product exists to show.
  const { events } = await harness();

  handlers.onAsrInitiationMetadata?.();
  handlers.onMessage?.({ message: "привет", source: "user" } as never);

  expect(lanes(events, "stage-start"), "llm opens once recognition is done").toContain("llm");
});

test("the model's stage closes when audio starts coming back", async () => {
  const { events } = await harness();

  handlers.onMessage?.({ message: "привет", source: "user" } as never);
  handlers.onAudio?.();

  expect(lanes(events, "stage-end")).toContain("llm");
  expect(lanes(events, "stage-start"), "synthesis takes over").toContain("tts");
});

test("a turn is reported when listening resumes", async () => {
  const { turns } = await harness();

  handlers.onModeChange?.({ mode: "speaking" } as never);
  handlers.onModeChange?.({ mode: "listening" } as never);

  expect(turns.length, "returning to listening ends the turn").toBe(1);
});

test("a disconnect closes every open lane", async () => {
  // Otherwise a stage stays open forever behind a dead socket.
  const { events } = await harness();

  handlers.onAsrInitiationMetadata?.();
  handlers.onModeChange?.({ mode: "speaking" } as never);
  handlers.onDisconnect?.({ reason: "agent" } as never);

  const closed = lanes(events, "stage-end");
  expect(closed).toContain("stt");
  expect(closed).toContain("playback");
});

test("each child session uses the Worker token and passes a fresh server prompt verbatim", async () => {
  const { session, childProfile, agentToken, startChildConversation } = makeSession(undefined, childId);
  const getPrompt = () =>
    (startOptions.overrides as { agent: { prompt: { prompt: string } } }).agent.prompt.prompt;

  await session.start();
  expect(childProfile).toHaveBeenCalledWith(childId);
  expect(agentToken).toHaveBeenCalledOnce();
  expect(startChildConversation).toHaveBeenCalledWith(childId, profile.rulesVersion);
  expect(startOptions.conversationToken).toBe(workerToken);
  expect(startOptions.clientTools).toBeUndefined();
  expect(startOptions.customLlmExtraBody).toBeUndefined();
  expect(getPrompt()).toBe(profile.prompt);

  await session.stop();
  const updated = { ...profile, prompt: "Use puzzles as examples.", rulesVersion: 3 };
  childProfile.mockResolvedValueOnce(updated);
  await session.start();
  expect(childProfile).toHaveBeenCalledTimes(2);
  expect(startChildConversation).toHaveBeenLastCalledWith(childId, updated.rulesVersion);
  expect(getPrompt()).toBe(updated.prompt);
});

test("a rejected Worker token prevents registering the child conversation or opening the SDK", async () => {
  const { session, agentToken, startChildConversation } = makeSession(undefined, childId);
  agentToken.mockRejectedValueOnce(new Error("Interview key rejected"));
  startOptions = {};

  await expect(session.start()).rejects.toThrow("Interview key rejected");
  expect(startChildConversation).not.toHaveBeenCalled();
  expect(startOptions).toEqual({});
});

function transcript(source: "user" | "ai", event_id: number, message: string) {
  handlers.onMessage({ source, event_id, message });
}

function mode(mode: "speaking" | "listening") {
  handlers.onModeChange({ mode });
}

test("the fixture records the final agent reply even when the same text already streamed", async () => {
  const { session, bus } = makeSession();
  const recorder = new Recorder(bus);
  recorder.start();
  await session.start();

  transcript("user", 1, "A question");
  handlers.onAgentChatResponsePart({ text: "An " });
  handlers.onAgentChatResponsePart({ text: "answer" });
  transcript("ai", 2, "An answer");
  await session.stop();

  expect(recorder.stop()?.lines.map(({ speaker, text }) => [speaker, text])).toEqual([
    ["user", "A question"], ["agent", "An answer"],
  ]);
});

test("reviews a child turn once after playback, with the last ten completed turns", async () => {
  vi.useFakeTimers();
  const { session, reviewTurn } = makeSession(undefined, childId);
  await session.start();
  transcript("ai", 1, "Привет!");
  mode("speaking");
  mode("listening");
  vi.advanceTimersByTime(1000);
  expect(reviewTurn).not.toHaveBeenCalled();

  for (let i = 1; i <= 12; i++) {
    transcript("user", i * 2, "Вопрос " + i);
    transcript("user", i * 2, "Повтор события");
    mode("speaking");
    transcript("ai", i * 2 + 1, "Ответ " + i);
    transcript("ai", i * 2 + 1, "Повтор ответа");
    expect(reviewTurn).toHaveBeenCalledTimes(i - 1);
    mode("listening");
    vi.advanceTimersByTime(50);
    mode("speaking");
    vi.advanceTimersByTime(200);
    expect(reviewTurn).toHaveBeenCalledTimes(i - 1);
    mode("listening");
    vi.advanceTimersByTime(200);
    expect(reviewTurn).toHaveBeenCalledTimes(i);
  }
  const first = reviewTurn.mock.calls[0][0];
  expect(first).toMatchObject({ childId, conversationId, turns: [{ input: "Вопрос 1", output: "Ответ 1" }] });
  const last = reviewTurn.mock.lastCall![0];
  expect(last.turnId).not.toBe(first.turnId);
  expect(last.turns.map(({ input }) => input)).toEqual(Array.from({ length: 10 }, (_, i) => "Вопрос " + (i + 3)));
  expect(last.turns.at(-1)).toEqual({ input: "Вопрос 12", output: "Ответ 12" });
  await session.stop();
  expect(reviewTurn).toHaveBeenCalledTimes(12);
  await session.start();
  transcript("user", 2, "Новый звонок");
  await session.stop();
  expect(reviewTurn.mock.lastCall![0].turns).toEqual([{ input: "Новый звонок", output: null }]);
});

test("reviews corrected interrupted audio and preserves the child input even without audio", async () => {
  vi.useFakeTimers();
  const { session, reviewTurn, endChildConversation } = makeSession(undefined, childId);
  await session.start();
  transcript("user", 2, "Первый вопрос");
  transcript("ai", 3, "Услышанная часть и продолжение");
  mode("speaking");
  handlers.onInterruption({ event_id: 3 });
  mode("listening");
  transcript("user", 4, "Второй вопрос");
  handlers.onAgentResponseCorrection({
    event_id: 3,
    original_agent_response: "Услышанная часть и продолжение", corrected_agent_response: "Услышанная часть",
  });
  expect(reviewTurn.mock.lastCall![0].turns).toEqual([{ input: "Первый вопрос", output: "Услышанная часть" }]);

  transcript("ai", 5, "Неподтверждённый ответ");
  mode("speaking");
  handlers.onInterruption({ event_id: 5 });
  mode("listening");
  vi.advanceTimersByTime(500);
  expect(reviewTurn.mock.lastCall![0].turns.at(-1)).toEqual({ input: "Второй вопрос", output: null });
  transcript("user", 6, "Последний вопрос");
  handlers.onDisconnect({ reason: "error", message: "test" });
  expect(reviewTurn.mock.lastCall![0].turns.at(-1)).toEqual({ input: "Последний вопрос", output: null });
  await session.stop();
  expect(reviewTurn).toHaveBeenCalledTimes(3);
  expect(endChildConversation).toHaveBeenCalledExactlyOnceWith(childId, conversationId, "failed");
});

test("the demo opens with its own prompt even when the child server is unavailable", async () => {
  vi.useFakeTimers();
  const { session, childProfile, startChildConversation, reviewTurn, endChildConversation } = makeSession();
  childProfile.mockRejectedValueOnce(new Error("profile unavailable"));
  await session.start();
  expect(startOptions).toMatchObject({
    conversationToken: workerToken, overrides: { agent: { prompt: { prompt: SYSTEM_PROMPT } } },
  });
  expect(childProfile).not.toHaveBeenCalled();
  expect(startChildConversation).not.toHaveBeenCalled();
  transcript("user", 2, "A demo question");
  transcript("ai", 3, "A demo answer");
  mode("speaking");
  mode("listening");
  vi.advanceTimersByTime(500);
  await session.stop();
  expect(reviewTurn).not.toHaveBeenCalled();
  expect(endChildConversation).not.toHaveBeenCalled();
});

test("a failed profile request prevents ElevenLabs from opening a session", async () => {
  const { session, childProfile } = makeSession(undefined, childId);
  childProfile.mockRejectedValueOnce(new Error("profile unavailable"));
  startOptions = {};

  await expect(session.start()).rejects.toThrow("profile unavailable");
  expect(startOptions).toEqual({});
  expect(session.isRunning).toBe(false);
});

test("closes the review record without opening the SDK if stopped during registration", async () => {
  const { session, startChildConversation, endChildConversation } = makeSession(undefined, childId);
  let finish = () => {};
  const registration = new Promise<void>((resolve) => { finish = resolve; });
  startChildConversation.mockImplementationOnce(async () => {
    await registration;
    return { conversationId };
  });
  const start = vi.spyOn(Conversation, "startSession");
  const starting = session.start();
  await vi.waitFor(() => expect(startChildConversation).toHaveBeenCalled());

  await session.stop();
  finish();
  await starting;

  expect(start).not.toHaveBeenCalled();
  expect(endChildConversation).toHaveBeenCalledExactlyOnceWith(childId, conversationId, "ended");
  expect(session.isRunning).toBe(false);
});

test("closes the SDK connection if the child call is stopped while connecting", async () => {
  const open = Conversation.startSession;
  const endSession = vi.fn(async () => {});
  let finish = () => {};
  const connection = new Promise<void>((resolve) => { finish = resolve; });
  const start = vi.spyOn(Conversation, "startSession").mockImplementationOnce(async (options) => {
    const conversation = await open(options);
    conversation.endSession = endSession;
    await connection;
    return conversation;
  });
  const { session, endChildConversation } = makeSession(undefined, childId);
  const starting = session.start();
  await vi.waitFor(() => expect(start).toHaveBeenCalled());

  await session.stop();
  finish();
  await starting;

  expect(endSession).toHaveBeenCalledOnce();
  expect(endChildConversation).toHaveBeenCalledExactlyOnceWith(childId, conversationId, "ended");
  expect(session.isRunning).toBe(false);
});

test("stopping a child call submits its last turn without waiting for SDK cleanup", async () => {
  const open = Conversation.startSession;
  let finish = () => {};
  const cleanup = new Promise<void>((resolve) => { finish = resolve; });
  vi.spyOn(Conversation, "startSession").mockImplementationOnce(async (options) => {
    const conversation = await open(options);
    conversation.endSession = () => cleanup;
    return conversation;
  });
  const { session, reviewTurn, endChildConversation } = makeSession(undefined, childId);
  await session.start();
  transcript("user", 2, "Last question");

  const stopping = session.stop();
  try {
    expect(reviewTurn.mock.lastCall?.[0].turns).toEqual([{ input: "Last question", output: null }]);
    expect(endChildConversation).toHaveBeenCalledExactlyOnceWith(childId, conversationId, "ended");
  } finally {
    finish();
    await stopping;
  }
});

test.each([true, false])("keeps private prompt data out of the console (dev: %s)", async (dev) => {
  vi.stubEnv("DEV", dev);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const prompt = "Parent's note: Use short examples about planets.";
  const { session } = makeSession(vi.fn(async () => ({ ...profile, prompt })), childId);

  await session.start();

  const { agent } = startOptions.overrides as { agent: { prompt: { prompt: string } } };
  expect(agent.prompt.prompt).toBe(prompt);
  expect(log).not.toHaveBeenCalled();
});

test("uses the SDK event IDs to keep a late correction out of the next interrupted turn", async () => {
  vi.useFakeTimers();
  const { session, reviewTurn } = makeSession(undefined, childId);
  await session.start();
  transcript("user", 2, "First question");
  handlers.onInterruption({ event_id: 3 });
  transcript("user", 4, "Second question");
  handlers.onInterruption({ event_id: 5 });
  handlers.onAgentResponseCorrection({
    original_agent_response: "First answer", corrected_agent_response: "First", event_id: 3,
  });
  expect(reviewTurn.mock.lastCall?.[0].turns).toEqual([{ input: "First question", output: "First" }]);
  handlers.onAgentResponseCorrection({
    original_agent_response: "Second answer", corrected_agent_response: "Second", event_id: 5,
  });
  expect(reviewTurn.mock.lastCall?.[0].turns).toEqual([
    { input: "First question", output: "First" }, { input: "Second question", output: "Second" },
  ]);
  await session.stop();
});

test("the token counter starts over on every turn instead of growing for the whole call", async () => {
  const { events } = await harness();
  const say = (text: string) => handlers.onAgentChatResponsePart?.({ text } as never);

  handlers.onModeChange?.({ mode: "listening" } as never);
  say("one ");
  say("two ");
  say("three");
  handlers.onModeChange?.({ mode: "speaking" } as never);
  handlers.onModeChange?.({ mode: "listening" } as never);
  say("four");

  const model = new TurnModel();
  for (const e of events) model.apply(e);
  expect(model.tokens).toBe(1);
});

test("end to end is the turn's wall-clock time, not the sum of overlapping stages", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { turns } = await harness();
  const at = (t: number, fire: () => void) => {
    now = t;
    fire();
  };

  at(0, () => handlers.onModeChange?.({ mode: "listening" } as never));
  at(100, () => handlers.onAsrInitiationMetadata?.());
  at(500, () => handlers.onMessage?.({ message: "hi", source: "user" } as never));
  at(800, () => handlers.onAudio?.());
  at(800, () => handlers.onModeChange?.({ mode: "speaking" } as never));
  at(2000, () => handlers.onModeChange?.({ mode: "listening" } as never));

  expect(turns[0].totalMs).toBe(2000);
});
