import { expect, test, vi } from "vitest";
import { AgentSession } from "./agentSession";
import { SYSTEM_PROMPT } from "../persona";
import { EventBus } from "../events";
import type { PipelineEvent, TurnMetrics } from "../types";

/** Captures the callbacks the SDK would have received, so they can be fired by hand. */
const handlers: Record<string, (arg?: unknown) => void> = {};
/** What the session asked the SDK for, so the handshake itself can be asserted on. */
let startOptions: Record<string, unknown> = {};

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

async function harness() {
  const bus = new EventBus();
  const events: PipelineEvent[] = [];
  bus.on((e) => events.push(e));

  const turns: TurnMetrics[] = [];

  const session = new AgentSession({
    bus,
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onTurn: (m) => turns.push(m),
    onEnded: () => {},
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

test("the role is sent with the handshake, not left to the agent's own prompt", async () => {
  await harness();

  const overrides = startOptions.overrides as
    | { agent?: { prompt?: { prompt?: string } } }
    | undefined;
  expect(overrides?.agent?.prompt?.prompt).toBe(SYSTEM_PROMPT);
});

test("the greeting is sent with the handshake", async () => {
  await harness();

  const overrides = startOptions.overrides as { agent?: { firstMessage?: string } } | undefined;
  expect(overrides?.agent?.firstMessage).toBe(
    "Здравствуйте! Меня зовут Александра, я администратор клуба Family Fitness. Чем могу вам помочь?",
  );
});

const replies = (events: PipelineEvent[]) =>
  events.filter((e) => e.type === "agent-reply").map((e) => (e as { text: string }).text);

const say = (text: string) => handlers.onMessage?.({ message: text, source: "ai" } as never);
const stream = (text: string) => handlers.onAgentChatResponsePart?.({ text } as never);

test("a final reply is announced once however it was streamed", async () => {
  const matched = await harness();
  stream("при");
  stream("вет");
  say("привет");
  expect(replies(matched.events), "the stream matched the final text").toEqual(["привет"]);

  const unstreamed = await harness();
  say("привет");
  expect(replies(unstreamed.events), "nothing was streamed").toEqual(["привет"]);

  const diverged = await harness();
  stream("прив");
  say("привет");
  expect(replies(diverged.events), "the stream differs from the final text").toEqual(["привет"]);
});

test("consecutive replies are each announced", async () => {
  const { events } = await harness();

  stream("первая");
  say("первая");
  stream("вторая");
  say("вторая");
  say("третья");

  expect(replies(events)).toEqual(["первая", "вторая", "третья"]);
});

test("a streamed reply still counts its tokens and characters", async () => {
  const { turns } = await harness();

  handlers.onModeChange?.({ mode: "speaking" } as never);
  stream("аб");
  stream("вг");
  say("абвг");
  handlers.onModeChange?.({ mode: "listening" } as never);

  expect(turns[0].llmTokens).toBe(2);
  expect(turns[0].ttsChars).toBe(4);
});
