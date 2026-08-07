import { expect, test, vi } from "vitest";
import { AgentSession } from "./agentSession";
import { EventBus } from "../events";
import type { PipelineEvent, TurnMetrics } from "../types";

/** Captures the callbacks the SDK would have received, so they can be fired by hand. */
const handlers: Record<string, (arg?: unknown) => void> = {};

vi.mock("@elevenlabs/client", () => ({
  Conversation: {
    startSession: async (opts: Record<string, unknown>) => {
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
  const alignments: Array<{ chars: string[]; startMs: number[] }> = [];

  const session = new AgentSession({
    bus,
    transport: { agentToken: async () => ({ token: "t", agentId: "a" }) } as never,
    onAlignment: (chars, startMs) => alignments.push({ chars, startMs }),
    onTurn: (m) => turns.push(m),
    onSpeaking: () => {},
    onEnded: () => {},
  });

  await session.start();
  return { session, events, turns, alignments };
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

test("alignment offsets advance by the latest end, not the last element", async () => {
  // The last character need not end latest. Taking the last element instead of the maximum
  // put every later chunk early, and the error accumulated across a reply.
  const { alignments } = await harness();

  handlers.onAudioAlignment?.({
    chars: ["а", "б", "в"],
    char_start_times_ms: [0, 50, 60],
    char_durations_ms: [50, 200, 20],
  } as never);
  handlers.onAudioAlignment?.({
    chars: ["г"],
    char_start_times_ms: [0],
    char_durations_ms: [10],
  } as never);

  // First chunk's latest end is 50 + 200 = 250.
  expect(alignments[1].startMs[0]).toBe(250);
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
