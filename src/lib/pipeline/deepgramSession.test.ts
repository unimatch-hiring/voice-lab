import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEEPGRAM_AGENT_URL, DeepgramSession, type ClientFunction } from "./deepgramSession";
import type { DeepgramAudio } from "./deepgramAudio";
import { EventBus } from "../events";
import type { PipelineEvent, TurnMetrics } from "../types";

/** Stands in for the browser WebSocket: records what was sent, lets the test play the server. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: FakeSocket | null = null;

  readyState = FakeSocket.OPEN;
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  closedWith: number | null = null;

  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeSocket.last = this;
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close(code: number) {
    this.closedWith = code;
    this.readyState = FakeSocket.CLOSED;
  }

  /** Server → client. */
  emit(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  audio(bytes = 480) {
    this.onmessage?.({ data: new ArrayBuffer(bytes) });
  }

  drop(code = 1011, reason = "") {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  json() {
    return this.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m));
  }
}

function fakeAudio() {
  let onFrame: ((pcm: ArrayBuffer, rms: number) => void) | null = null;
  let playing = 0;
  const audio = {
    inputRate: 48000,
    onDrained: null as (() => void) | null,
    played: 0,
    flushed: 0,
    closed: false,
    start: vi.fn(async (cb: (pcm: ArrayBuffer, rms: number) => void) => {
      onFrame = cb;
    }),
    play: () => {
      audio.played += 1;
      playing += 1;
    },
    flush: () => {
      audio.flushed += 1;
      playing = 0;
    },
    isPlaying: () => playing > 0,
    spectrum: () => (playing > 0 ? new Uint8Array(1024).fill(200) : null),
    close: async () => {
      audio.closed = true;
    },
    /** Microphone → session. */
    speak: (bytes = 640) => onFrame?.(new ArrayBuffer(bytes), 0.3),
    /** Playback queue runs dry. */
    drain: () => {
      playing = 0;
      audio.onDrained?.();
    },
  };
  return audio;
}

beforeEach(() => {
  FakeSocket.last = null;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface HarnessOptions {
  functions?: ClientFunction[];
  prompt?: string;
}

async function harness({ functions, prompt = "unused" }: HarnessOptions = {}) {
  const bus = new EventBus();
  const events: PipelineEvent[] = [];
  bus.on((e) => events.push(e));
  const turns: TurnMetrics[] = [];
  const ended: { reason: string; message?: string }[] = [];
  const audio = fakeAudio();

  const session = new DeepgramSession({
    bus,
    transport: { deepgramToken: async () => ({ token: "jwt-1" }) } as never,
    onTurn: (m) => turns.push(m),
    onEnded: (reason, message) => ended.push({ reason, message }),
    functions,
    audio: () => audio as unknown as DeepgramAudio,
    prompt,
  });

  const started = session.start();
  // Microphone and token are awaited before the socket exists.
  await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
  const socket = FakeSocket.last!;
  socket.emit({ type: "Welcome", request_id: "r1" });
  socket.emit({ type: "SettingsApplied" });
  await started;

  return { session, socket, audio, events, turns, ended };
}

const lanes = (events: PipelineEvent[], type: "stage-start" | "stage-end") =>
  events.filter((e) => e.type === type).map((e) => (e as { stage: string }).stage);

const clock: ClientFunction = {
  name: "get_clock",
  description: "Current time",
  parameters: { type: "object", properties: {} },
  run: () => "10:42",
};

test("opens the agent socket with the grant as a bearer subprotocol, not the API key", async () => {
  const { socket } = await harness();

  expect(socket.url).toBe(DEEPGRAM_AGENT_URL);
  expect(socket.protocols).toEqual(["bearer", "jwt-1"]);
});

test("sends Settings only after Welcome, and nothing before it", async () => {
  const audio = fakeAudio();
  const session = new DeepgramSession({
    bus: new EventBus(),
    transport: { deepgramToken: async () => ({ token: "jwt-1" }) } as never,
    onTurn: () => {},
    onEnded: () => {},
    audio: () => audio as unknown as DeepgramAudio,
    prompt: "unused",
  });
  void session.start();
  await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
  const socket = FakeSocket.last!;

  expect(socket.sent, "the server ignores anything before Welcome").toHaveLength(0);
  socket.emit({ type: "Welcome" });
  expect(socket.json()[0].type).toBe("Settings");
});

test("Settings carry the prompt the session was given, the client functions and English-only managed models", async () => {
  const { socket } = await harness({ functions: [clock], prompt: "theme for this start" });

  const settings = socket.json().find((m) => m.type === "Settings");
  expect(settings.audio.input).toEqual({ encoding: "linear16", sample_rate: 48000 });
  expect(settings.audio.output.sample_rate).toBe(24000);
  expect(settings.agent.think.prompt).toBe("theme for this start");
  expect(settings.agent.think.provider.type, "managed LLM, no key of ours").toBe("open_ai");
  expect(settings.agent.think.endpoint, "no endpoint means Deepgram-managed").toBeUndefined();
  expect(settings.agent.think.functions).toEqual([
    { name: "get_clock", description: "Current time", parameters: clock.parameters },
  ]);
  expect(settings.agent.think.functions[0].endpoint, "no endpoint means client-side").toBeUndefined();
  expect(settings.agent.speak.provider.model).toMatch(/-en$/);
  expect(settings.agent.listen.provider.language).toBe("en");
});

test("microphone audio waits for SettingsApplied", async () => {
  const audio = fakeAudio();
  const session = new DeepgramSession({
    bus: new EventBus(),
    transport: { deepgramToken: async () => ({ token: "jwt-1" }) } as never,
    onTurn: () => {},
    onEnded: () => {},
    audio: () => audio as unknown as DeepgramAudio,
    prompt: "unused",
  });
  const started = session.start();
  await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
  const socket = FakeSocket.last!;
  socket.emit({ type: "Welcome" });

  audio.speak();
  expect(socket.sent.filter((m) => m instanceof ArrayBuffer)).toHaveLength(0);

  socket.emit({ type: "SettingsApplied" });
  await started;
  audio.speak();
  expect(socket.sent.filter((m) => m instanceof ArrayBuffer)).toHaveLength(1);
});

test("a client-side function call runs here and its result goes back under the same id", async () => {
  const { socket } = await harness({ functions: [clock] });

  socket.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "fc_1", name: "get_clock", arguments: "{}", client_side: true }],
  });

  await vi.waitFor(() =>
    expect(socket.json()).toContainEqual({
      type: "FunctionCallResponse",
      id: "fc_1",
      name: "get_clock",
      content: "10:42",
    }),
  );
});

test("the function receives the parsed arguments", async () => {
  const run = vi.fn(() => "ok");
  const { socket } = await harness({ functions: [{ ...clock, run }] });

  socket.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "fc_2", name: "get_clock", arguments: '{"zone":"UTC"}', client_side: true }],
  });

  await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ zone: "UTC" }));
});

test("a server-side call is left to the server", async () => {
  const run = vi.fn(() => "ok");
  const { socket } = await harness({ functions: [{ ...clock, run }] });

  socket.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "fc_3", name: "get_clock", arguments: "{}", client_side: false }],
  });
  await Promise.resolve();

  expect(run).not.toHaveBeenCalled();
  expect(socket.json().some((m) => m.type === "FunctionCallResponse")).toBe(false);
});

test("an unknown or failing function still answers, so the turn is not left hanging", async () => {
  const { socket } = await harness();

  socket.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "fc_4", name: "nope", arguments: "{}", client_side: true }],
  });

  await vi.waitFor(() => {
    const reply = socket.json().find((m) => m.type === "FunctionCallResponse");
    expect(reply.id).toBe("fc_4");
    expect(JSON.parse(reply.content).error).toMatch(/nope/);
  });
});

test("a cancelled call gets no response", async () => {
  let finish: (v: string) => void = () => {};
  const slow: ClientFunction = { ...clock, run: () => new Promise((r) => (finish = r)) };
  const { socket } = await harness({ functions: [slow] });

  socket.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "fc_5", name: "get_clock", arguments: "{}", client_side: true }],
  });
  socket.emit({ type: "FunctionCallCancelled", functions: [{ id: "fc_5", name: "get_clock" }] });
  finish("late");
  await new Promise((r) => setTimeout(r, 0));

  expect(socket.json().some((m) => m.type === "FunctionCallResponse")).toBe(false);
});

test("the user talking over the agent drops queued audio and ends the reply", async () => {
  const { socket, audio, events, turns } = await harness();

  socket.emit({ type: "ConversationText", role: "user", content: "hi" });
  socket.audio();
  socket.audio();
  expect(lanes(events, "stage-start")).toContain("playback");

  socket.emit({ type: "UserStartedSpeaking" });

  expect(audio.flushed, "queued agent audio would talk over the user").toBe(1);
  expect(lanes(events, "stage-end")).toContain("tts");
  expect(turns, "the interrupted turn is still reported").toHaveLength(1);
});

test("a reply ends when playback drains, not when the server finishes sending", async () => {
  // AgentAudioDone means the last chunk left Deepgram; the user may still be hearing it.
  const { socket, audio, turns } = await harness();

  socket.emit({ type: "ConversationText", role: "user", content: "hi" });
  socket.audio();
  socket.emit({ type: "AgentAudioDone" });
  expect(turns).toHaveLength(0);

  audio.drain();
  expect(turns).toHaveLength(1);
});

test("stage lanes follow the turn: stt, then llm, then tts", async () => {
  const { socket, events } = await harness();

  socket.emit({ type: "UserStartedSpeaking" });
  socket.emit({ type: "ConversationText", role: "user", content: "hi" });
  socket.audio();

  expect(lanes(events, "stage-start")).toEqual(
    expect.arrayContaining(["capture", "stt", "llm", "tts", "playback"]),
  );
  expect(lanes(events, "stage-end")).toEqual(expect.arrayContaining(["stt", "llm"]));
  const stt = events.find((e) => e.type === "stt-result");
  expect(stt && stt.type === "stt-result" && stt.result.text).toBe("hi");
});

test("the agent's line reaches the transcript", async () => {
  const { socket, events } = await harness();

  socket.emit({ type: "ConversationText", role: "assistant", content: "Hello there." });

  expect(events).toContainEqual(expect.objectContaining({ type: "agent-reply", text: "Hello there." }));
});

test("the mouth reads the playing audio, and nothing once it stops", async () => {
  const { socket, audio, session } = await harness();
  expect(session.mouthSpectrum()).toBeNull();

  socket.audio();
  expect(session.mouthSpectrum()).not.toBeNull();

  socket.emit({ type: "AgentAudioDone" });
  audio.drain();
  expect(session.mouthSpectrum()).toBeNull();
});

test("typed text goes in as the user's turn", async () => {
  const { socket, session } = await harness();

  session.sendText("What can you do?");

  expect(socket.json()).toContainEqual({ type: "InjectUserMessage", content: "What can you do?" });
});

test("an injected agent line reports whether it was spoken or refused", async () => {
  const { socket, session } = await harness();

  const refused = session.injectAgentMessage("One moment.");
  expect(socket.json()).toContainEqual({
    type: "InjectAgentMessage",
    message: "One moment.",
    behavior: "default",
  });
  socket.emit({ type: "InjectionRefused" });
  expect(await refused).toBe(false);

  const spoken = session.injectAgentMessage("One moment.", "queue");
  socket.emit({ type: "ConversationText", role: "assistant", content: "Something else." });
  socket.emit({ type: "ConversationText", role: "assistant", content: "One moment." });
  expect(await spoken).toBe(true);
});

test("a dropped connection ends the conversation as an error and closes every lane", async () => {
  const { socket, events, ended, audio } = await harness();
  socket.emit({ type: "UserStartedSpeaking" });

  socket.emit({ type: "Error", description: "Think provider failed", code: "THINK_FAILED" });
  socket.drop(1011);

  expect(ended).toEqual([{ reason: "error", message: "Think provider failed" }]);
  expect(lanes(events, "stage-end")).toEqual(expect.arrayContaining(["stt", "capture"]));
  expect(audio.closed, "the microphone is released").toBe(true);
});

test("stopping closes the socket and the microphone and reports the user", async () => {
  const { socket, session, ended, audio } = await harness();

  await session.stop();

  expect(socket.closedWith).toBe(1000);
  expect(audio.closed).toBe(true);
  expect(session.isRunning).toBe(false);
  expect(ended).toEqual([{ reason: "user", message: undefined }]);
});

test("a socket closed during the handshake fails start and releases the microphone", async () => {
  const audio = fakeAudio();
  const session = new DeepgramSession({
    bus: new EventBus(),
    transport: { deepgramToken: async () => ({ token: "jwt-1" }) } as never,
    onTurn: () => {},
    onEnded: () => {},
    audio: () => audio as unknown as DeepgramAudio,
    prompt: "unused",
  });
  const started = session.start();
  await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
  FakeSocket.last!.drop(1008, "invalid token");

  await expect(started).rejects.toThrow(/invalid token/);
  expect(audio.closed).toBe(true);
  expect(session.isRunning).toBe(false);
});

test("a denied microphone fails before a token is spent", async () => {
  const deepgramToken = vi.fn();
  const audio = fakeAudio();
  audio.start.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
  const session = new DeepgramSession({
    bus: new EventBus(),
    transport: { deepgramToken } as never,
    onTurn: () => {},
    onEnded: () => {},
    audio: () => audio as unknown as DeepgramAudio,
    prompt: "unused",
  });

  await expect(session.start()).rejects.toThrow(/denied/);
  expect(deepgramToken).not.toHaveBeenCalled();
});
