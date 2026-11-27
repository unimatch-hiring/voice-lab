import { afterEach, expect, test, vi } from "vitest";
import { AgentSession } from "./agentSession";
import { SYSTEM_PROMPT } from "../persona";
import { EventBus } from "../events";
import type { PipelineEvent, TurnMetrics } from "../types";
import { TurnModel } from "../../scene/turnModel";

/** Captures the callbacks the SDK would have received, so they can be fired by hand. */
const handlers: Record<string, (arg?: unknown) => void> = {};
/** What the session asked the SDK for, so the handshake itself can be asserted on. */
let startOptions: Record<string, unknown> = {};
/** What the session pushed into the live conversation after the handshake. */
const sent: [string, string][] = [];

vi.mock("@elevenlabs/client", () => ({
  Conversation: {
    startSession: async (opts: Record<string, unknown>) => {
      startOptions = opts;
      for (const [key, value] of Object.entries(opts)) {
        if (typeof value === "function") handlers[key] = value as () => void;
      }
      return {
        endSession: async () => {},
        sendContextualUpdate: (text: string) => sent.push(["context", text]),
        sendUserMessage: (text: string) => sent.push(["user", text]),
        getOutputVolume: () => 0,
        getOutputByteFrequencyData: () => new Uint8Array(1024),
      };
    },
  },
}));

afterEach(() => vi.restoreAllMocks());

async function harness(briefing?: () => string) {
  const bus = new EventBus();
  const events: PipelineEvent[] = [];
  bus.on((e) => events.push(e));

  const turns: TurnMetrics[] = [];

  const session = new AgentSession({
    bus,
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onTurn: (m) => turns.push(m),
    onEnded: () => {},
    briefing,
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

test("what is on file about the customer rides in the prompt, so the greeting already knows them", async () => {
  await harness(() => "Returning customer: Анна");

  const prompt = (startOptions.overrides as { agent: { prompt: { prompt: string } } }).agent.prompt.prompt;
  expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true);
  expect(prompt).toContain("Returning customer: Анна");
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

test("context and typed turns go through the SDK's own methods, each to its own", async () => {
  sent.length = 0;
  const { session } = await harness();

  session.sendContextualUpdate("Customer name: Anna.");
  session.sendUserMessage("Book me for tomorrow.");

  expect(sent).toEqual([
    ["context", "Customer name: Anna."],
    ["user", "Book me for tomorrow."],
  ]);
});

test("the page's tools are handed to the SDK as client tools, by name", async () => {
  const session = new AgentSession({
    bus: new EventBus(),
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onTurn: () => {},
    onEnded: () => {},
    functions: [{ name: "update_form", description: "", parameters: {}, run: () => "filled" }],
  });
  await session.start();

  const tools = startOptions.clientTools as Record<string, (a: unknown) => string>;
  expect(tools.update_form({})).toBe("filled");
});
