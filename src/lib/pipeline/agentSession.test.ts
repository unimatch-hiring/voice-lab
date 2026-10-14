import { expect, test, vi } from "vitest";
import { AgentSession } from "./agentSession";
import { DIRECTIVE_MARKER, SYSTEM_PROMPT } from "../persona";
import { steerDirective } from "../tutor/lesson";
import { EventBus } from "../events";
import type { PipelineEvent, TurnMetrics } from "../types";

/** Captures the callbacks the SDK would have received, so they can be fired by hand. */
const handlers: Record<string, (arg?: unknown) => void> = {};
/** What the session asked the SDK for, so the handshake itself can be asserted on. */
let startOptions: Record<string, unknown> = {};
/** Contextual updates the SDK was handed, i.e. what the tutor managed to say. */
let contextSent: string[] = [];

vi.mock("@elevenlabs/client", () => ({
  Conversation: {
    startSession: async (opts: Record<string, unknown>) => {
      startOptions = opts;
      for (const [key, value] of Object.entries(opts)) {
        if (typeof value === "function") handlers[key] = value as () => void;
      }
      contextSent = [];
      return {
        endSession: async () => {},
        sendContextualUpdate: (text: string) => contextSent.push(text),
        getOutputVolume: () => 0,
        getOutputByteFrequencyData: () => new Uint8Array(1024),
      };
    },
  },
}));

async function harness(openingContext = "") {
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

  await session.start(openingContext);
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

test("an instruction can be handed to a running conversation", async () => {
  // The role travels in the handshake and cannot be changed afterwards, so this is
  // the tutor's only way to steer a lesson that is already under way.
  const { session } = await harness();

  session.sendContext("[TUTOR DIRECTIVE] stay in English");

  expect(contextSent).toEqual(["[TUTOR DIRECTIVE] stay in English"]);
});

test("an instruction after the conversation dropped is not sent anywhere", async () => {
  // The handle is dropped on disconnect precisely so late calls go nowhere; without
  // that this throws inside whatever happened to still be running.
  const { session } = await harness();

  handlers.onDisconnect?.({ reason: "agent" } as never);
  expect(() => session.sendContext("[TUTOR DIRECTIVE] stay in English")).not.toThrow();
  expect(contextSent).toEqual([]);
});

test("the prompt tells the agent what to do with the directives it will be sent", () => {
  // The two halves of one contract. Without this, deleting the prompt's DIRECTIVES
  // section left every test green while the agent began reading
  // "[TUTOR DIRECTIVE] The learner just spoke Russian…" aloud to the learner.
  expect(SYSTEM_PROMPT).toContain(DIRECTIVE_MARKER);
  expect(SYSTEM_PROMPT, "and says not to speak them").toMatch(/[Nn]ever read it aloud/);
  expect(steerDirective(1).startsWith(DIRECTIVE_MARKER), "same marker both ways").toBe(true);
});
