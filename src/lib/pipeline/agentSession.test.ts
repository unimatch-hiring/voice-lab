import { expect, test, vi } from "vitest";
import { AgentSession } from "./agentSession";
import { SYSTEM_PROMPT } from "../persona";
import type { LayerStack } from "./layers/orchestrator";
import { EventBus } from "../events";
import type { PipelineEvent, TurnMetrics } from "../types";

/** Captures the callbacks the SDK would have received, so they can be fired by hand. */
const handlers: Record<string, (arg?: unknown) => void> = {};
/** What the session asked the SDK for, so the handshake itself can be asserted on. */
let startOptions: Record<string, unknown> = {};
/** Context the layers pushed into the live conversation. */
let contextPushes: string[] = [];

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
        sendContextualUpdate: (text: string) => contextPushes.push(text),
        sendUserMessage: () => {},
      };
    },
  },
}));

async function harness(layers?: Partial<LayerStack>) {
  contextPushes = [];
  const bus = new EventBus();
  const events: PipelineEvent[] = [];
  bus.on((e) => events.push(e));

  const turns: TurnMetrics[] = [];

  const session = new AgentSession({
    bus,
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onTurn: (m) => turns.push(m),
    onEnded: () => {},
    layers: (layers ?? null) as LayerStack | null,
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

test("the layers see both halves of the conversation", async () => {
  const seen: string[] = [];
  const { session } = await harness({
    onUserUtterance: async (t: string) => void seen.push(`user:${t}`),
    onAgentReply: (t: string) => void seen.push(`agent:${t}`),
    onTurnEnd: async () => {},
    close: () => {},
  } as never);

  handlers.onMessage?.({ message: "how much can it tow", source: "user" } as never);
  handlers.onMessage?.({ message: "plenty", source: "ai" } as never);
  await session.stop();

  expect(seen).toEqual(["user:how much can it tow", "agent:plenty"]);
});

test("a layer that never finishes does not hold up the reply", async () => {
  // The layers ride along beside a reply ElevenLabs has already started. Awaiting one
  // anywhere in the turn would put a validator's latency in front of speech.
  const { events } = await harness({
    onUserUtterance: () => new Promise<void>(() => {}),
    onAgentReply: () => {},
    onTurnEnd: () => new Promise<void>(() => {}),
    close: () => {},
  } as never);

  handlers.onMessage?.({ message: "hello", source: "user" } as never);
  handlers.onAudio?.();
  handlers.onMessage?.({ message: "hi there", source: "ai" } as never);

  expect(lanes(events, "stage-start"), "synthesis still opened").toContain("tts");
  expect(events.some((e) => e.type === "agent-reply")).toBe(true);
});

test("the turn boundary is announced, not only reported to App", async () => {
  // `turn-start` and `turn-end` were declared and handled but never emitted, so the
  // waterfall's token counter never reset across a session.
  const { events } = await harness();

  handlers.onModeChange?.({ mode: "speaking" } as never);
  handlers.onModeChange?.({ mode: "listening" } as never);

  expect(events.some((e) => e.type === "turn-end")).toBe(true);
  expect(events.some((e) => e.type === "turn-start")).toBe(true);
});

test("recall is offered to the agent as a tool it can wait for", async () => {
  await harness({ recall: async (q: string) => `recalled ${q}` } as never);

  const tools = startOptions.clientTools as Record<string, (a: unknown) => Promise<string>>;
  await expect(tools.recall_from_conversation({ query: "towing" })).resolves.toBe(
    "recalled towing",
  );
});

test("context reaches the live conversation without taking a turn", async () => {
  const { session } = await harness();

  session.pushContext("the budget is 60 thousand");

  expect(contextPushes).toEqual(["the budget is 60 thousand"]);
});
