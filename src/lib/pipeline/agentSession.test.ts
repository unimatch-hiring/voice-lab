import { expect, test, vi } from "vitest";
import { AgentSession } from "./agentSession";
import { EventBus } from "../events";
import type { PipelineEvent, TurnMetrics } from "../types";

/** Captures the callbacks the SDK would have received, so they can be fired by hand. */
const handlers: Record<string, (arg?: unknown) => void> = {};
/** What the session asked the SDK for, so the handshake itself can be asserted on. */
let startOptions: Record<string, unknown> = {};
const contextualUpdates: [string, unknown][] = [];

vi.mock("@elevenlabs/client", () => ({
  Conversation: {
    startSession: async (opts: Record<string, unknown>) => {
      startOptions = opts;
      for (const [key, value] of Object.entries(opts)) {
        if (typeof value === "function") handlers[key] = value as () => void;
      }
      return {
        sendContextualUpdate: (text: string, options: unknown) => contextualUpdates.push([text, options]),
        endSession: async () => {},
        getOutputVolume: () => 0,
        getOutputByteFrequencyData: () => new Uint8Array(1024),
      };
    },
  },
}));

async function harness(prompt = "unused") {
  const bus = new EventBus();
  const events: PipelineEvent[] = [];
  bus.on((e) => events.push(e));

  const turns: TurnMetrics[] = [];

  const session = new AgentSession({
    bus,
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onTurn: (m) => turns.push(m),
    onEnded: () => {},
    prompt,
  });

  await session.start();
  return { session, events, turns };
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

test("the handshake sends the prompt the session was given", async () => {
  await harness("theme for this start");

  const overrides = startOptions.overrides as
    | { agent?: { prompt?: { prompt?: string } } }
    | undefined;
  expect(overrides?.agent?.prompt?.prompt).toBe("theme for this start");
});

test("the handshake sends the role's model, language and recogniser hints", async () => {
  const session = new AgentSession({
    bus: new EventBus(),
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onTurn: () => {},
    onEnded: () => {},
    prompt: "coach",
    llm: "claude-sonnet-5-5",
    language: "ru",
    asrKeywords: ["ЧГК", "Брейн-ринг"],
  });
  await session.start();

  expect(startOptions.overrides).toEqual({
    agent: { prompt: { prompt: "coach", llm: "claude-sonnet-5-5" }, language: "ru" },
    asr: { keywords: ["ЧГК", "Брейн-ринг"] },
  });
});

test("a role without a model or language sends neither, so an agent that forbids them still connects", async () => {
  await harness("general");

  expect(startOptions.overrides).toEqual({ agent: { prompt: { prompt: "general" } } });
});

test("knowledge for the person's words goes to the agent as one replaceable contextual update", async () => {
  contextualUpdates.length = 0;
  const knowledgeFor = vi.fn((words: string) => (words.includes("фальстарт") ? "## Брейн-ринг: фальстарт" : null));
  const session = new AgentSession({
    bus: new EventBus(),
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onTurn: () => {},
    onEnded: () => {},
    prompt: "coach",
    knowledgeFor,
  });
  await session.start();

  handlers.onMessage?.({ message: "Что такое фальстарт?", source: "user" } as never);
  handlers.onMessage?.({ message: "Привет", source: "user" } as never);
  handlers.onMessage?.({ message: "Фальстарт — это ответ до сигнала.", source: "ai" } as never);

  expect(knowledgeFor.mock.calls.map((c) => c[0]), "only the person's words are searched").toEqual([
    "Что такое фальстарт?",
    "Привет",
  ]);
  expect(contextualUpdates).toEqual([["## Брейн-ринг: фальстарт", { contextId: "knowledge" }]]);
});

test("the same material is not sent again while the model still holds it", async () => {
  contextualUpdates.length = 0;
  const knowledgeFor = (words: string) => (words.includes("фальстарт") ? "## фальстарт" : "## засветка");
  const session = new AgentSession({
    bus: new EventBus(),
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onTurn: () => {},
    onEnded: () => {},
    prompt: "coach",
    knowledgeFor,
  });
  await session.start();

  for (const message of ["Что такое фальстарт?", "А штраф за фальстарт?", "А засветка?", "Снова про фальстарт"]) {
    handlers.onMessage?.({ message, source: "user" } as never);
  }

  expect(contextualUpdates.map(([text]) => text)).toEqual(["## фальстарт", "## засветка", "## фальстарт"]);
});
