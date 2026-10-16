import { Desmoother } from "../mouthLevel";
import type { StageName, TurnMetrics } from "../types";
import { createBrowserAudio, OUTPUT_RATE, type DeepgramAudio } from "./deepgramAudio";
import type { SessionDeps, VoiceSession } from "./session";

/**
 * The same session contract on Deepgram's Voice Agent API: one WebSocket carries
 * Settings, PCM both ways and the events. Protocol reference:
 * https://developers.deepgram.com/docs/voice-agent-message-flow
 */
export const DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";

/** A function the agent may call; it runs here in the page, not on Deepgram's side. */
export interface ClientFunction {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** The result goes back to the model as text. */
  run(args: Record<string, unknown>): string | Promise<string>;
}

export type InjectBehavior = "default" | "queue" | "interrupt";

export interface DeepgramSessionDeps extends SessionDeps {
  functions?: ClientFunction[];
  /** Audio hardware; replaced in tests. */
  audio?: () => DeepgramAudio;
}

/** Managed models in Deepgram's Standard tier: no LLM or TTS keys of our own. */
export const DEEPGRAM_MODELS = {
  listen: "nova-3",
  think: "gpt-4o-mini",
  // Aura voices are English-only, which is why the page warns about the language.
  speak: "aura-2-thalia-en",
} as const;

type ServerMessage =
  | { type: "Welcome" }
  | { type: "SettingsApplied" }
  | { type: "UserStartedSpeaking" }
  | { type: "ConversationText"; role: "user" | "assistant"; content: string }
  | {
      type: "FunctionCallRequest";
      functions: { id: string; name: string; arguments: string; client_side: boolean }[];
    }
  | { type: "FunctionCallCancelled"; functions: { id: string }[] }
  | { type: "AgentAudioDone" }
  | { type: "InjectionRefused" }
  | { type: "Error"; description?: string; message?: string; code?: string }
  | { type: string };

export class DeepgramSession implements VoiceSession {
  private socket: WebSocket | null = null;
  private audio: DeepgramAudio | null = null;
  private running = false;
  private stopping = false;
  private ready = false;

  private stageAt = 0;
  private stage: StageName | null = null;
  private metrics: TurnMetrics = { stages: {}, llmTokens: 0, ttsChars: 0 };
  private lanes = new Map<StageName, number>();
  /** Agent audio is queued or playing. */
  private speaking = false;
  /** The server has sent the last chunk of the current reply. */
  private replySent = false;
  private cancelled = new Set<string>();
  private lastError: string | undefined;
  private injection: { text: string; settle: (spoken: boolean) => void } | null = null;
  private sharpen = new Desmoother();

  constructor(private deps: DeepgramSessionDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  mouthSpectrum(): Uint8Array | null {
    if (!this.running || !this.speaking || !this.audio) return null;
    const spectrum = this.audio.spectrum();
    return spectrum ? this.sharpen.apply(spectrum) : null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.resetTurn();

    // Microphone first: a denied permission should fail before a token is spent.
    const audio = (this.deps.audio ?? createBrowserAudio)();
    this.audio = audio;
    audio.onDrained = this.onDrained;
    try {
      await audio.start((pcm, rms) => {
        if (!this.ready) return;
        this.socket?.send(pcm);
        this.deps.bus.emit({ type: "audio-level", rms, at: performance.now() });
      });
      const { token } = await this.deps.transport.deepgramToken();
      await this.connect(token, audio);
    } catch (e) {
      await this.teardown();
      throw e;
    }
    this.running = true;
  }

  /** InjectUserMessage. */
  sendText(text: string): void {
    this.send({ type: "InjectUserMessage", content: text });
  }

  /** InjectAgentMessage. Resolves false on InjectionRefused, true once it is spoken. */
  injectAgentMessage(message: string, behavior: InjectBehavior = "default"): Promise<boolean> {
    this.settleInjection(false);
    return new Promise((resolve) => {
      this.injection = { text: message.trim(), settle: resolve };
      this.send({ type: "InjectAgentMessage", message, behavior });
    });
  }

  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.stopping = true;
    this.running = false;
    await this.teardown();
    if (wasRunning) this.deps.onEnded("user");
  }

  private connect(token: string, audio: DeepgramAudio): Promise<void> {
    return new Promise((resolve, reject) => {
      // Browsers cannot set Authorization on a WebSocket; Deepgram takes it as a subprotocol.
      const socket = new WebSocket(DEEPGRAM_AGENT_URL, ["bearer", token]);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.onmessage = (e: MessageEvent) => {
        if (typeof e.data !== "string") {
          this.onAudio(e.data as ArrayBuffer);
          return;
        }
        const msg = JSON.parse(e.data) as ServerMessage;
        if (msg.type === "Welcome") {
          this.send(this.settings(audio.inputRate));
        } else if (msg.type === "SettingsApplied") {
          this.ready = true;
          this.openStage("capture");
          resolve();
        } else {
          this.onMessage(msg);
        }
      };

      socket.onclose = (e: CloseEvent) => {
        const reason = this.lastError ?? (e.reason || `connection closed (${e.code})`);
        if (!this.ready) {
          reject(new Error(reason));
          return;
        }
        this.onClosed(e.code === 1000 && !this.lastError ? "agent" : "error", reason);
      };
    });
  }

  private settings(inputRate: number) {
    const functions = this.deps.functions?.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    return {
      type: "Settings",
      audio: {
        input: { encoding: "linear16", sample_rate: inputRate },
        output: { encoding: "linear16", sample_rate: OUTPUT_RATE, container: "none" },
      },
      agent: {
        listen: { provider: { type: "deepgram", model: DEEPGRAM_MODELS.listen, language: "en" } },
        think: {
          provider: { type: "open_ai", model: DEEPGRAM_MODELS.think },
          prompt: this.deps.prompt,
          ...(functions?.length ? { functions } : {}),
        },
        speak: { provider: { type: "deepgram", model: DEEPGRAM_MODELS.speak } },
      },
    };
  }

  private onAudio(pcm: ArrayBuffer): void {
    if (!this.speaking) {
      const at = performance.now();
      this.speaking = true;
      this.replySent = false;
      this.closeLane("llm", at);
      this.openLane("tts", at);
      this.openStage("playback");
    }
    this.audio?.play(pcm);
  }

  private onMessage(msg: ServerMessage): void {
    const at = performance.now();
    switch (msg.type) {
      case "UserStartedSpeaking":
        // Barge-in: what is still queued would talk over the user.
        if (this.speaking) {
          this.audio?.flush();
          this.speaking = false;
          this.closeLane("tts", at);
        }
        this.openStage("capture");
        this.openLane("stt", at);
        return;

      case "ConversationText": {
        const { role, content } = msg as { role: string; content: string };
        if (role === "user") {
          this.closeLane("stt", at);
          this.openLane("llm", at);
          this.deps.bus.emit({ type: "stt-result", result: { text: content, words: [] } });
          return;
        }
        this.metrics.ttsChars += content.length;
        this.deps.bus.emit({ type: "agent-reply", text: content, at });
        if (this.injection?.text === content.trim()) this.settleInjection(true);
        return;
      }

      case "FunctionCallRequest":
        for (const call of (msg as Extract<ServerMessage, { type: "FunctionCallRequest" }>)
          .functions) {
          if (call.client_side) void this.runFunction(call);
        }
        return;

      case "FunctionCallCancelled":
        for (const { id } of (msg as { functions: { id: string }[] }).functions) {
          this.cancelled.add(id);
        }
        return;

      case "AgentAudioDone":
        this.replySent = true;
        this.closeLane("tts", at);
        if (!this.audio?.isPlaying()) this.endReply();
        return;

      case "InjectionRefused":
        this.settleInjection(false);
        return;

      case "Error": {
        const err = msg as { description?: string; message?: string; code?: string };
        this.lastError = err.description ?? err.message ?? err.code ?? "Deepgram error";
        this.deps.bus.emit({ type: "stage-error", stage: this.stage ?? "stt", at, message: this.lastError });
        return;
      }
    }
  }

  private async runFunction(call: { id: string; name: string; arguments: string }) {
    const fn = this.deps.functions?.find((f) => f.name === call.name);
    let content: string;
    try {
      if (!fn) throw new Error(`no client function named ${call.name}`);
      const args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
      content = await fn.run(args);
    } catch (e) {
      // An answer the model can read beats silence: without one the turn never finishes.
      content = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    // The server drops a late answer to a cancelled call; sending it would only confuse the log.
    if (this.cancelled.delete(call.id)) return;
    this.send({ type: "FunctionCallResponse", id: call.id, name: call.name, content });
  }

  /** Playback, not the server's AgentAudioDone, decides when the user stopped hearing it. */
  private onDrained = () => {
    if (this.replySent) this.endReply();
  };

  private endReply(): void {
    this.speaking = false;
    this.replySent = false;
    this.openStage("capture");
  }

  private settleInjection(spoken: boolean): void {
    const pending = this.injection;
    this.injection = null;
    pending?.settle(spoken);
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onClosed(reason: "agent" | "error", message: string): void {
    const wasRunning = this.running;
    this.running = false;
    void this.teardown();
    if (wasRunning && !this.stopping) {
      this.deps.onEnded(reason, reason === "error" ? message : undefined);
    }
  }

  private async teardown(): Promise<void> {
    this.ready = false;
    this.speaking = false;
    this.settleInjection(false);
    this.closeAllLanes(performance.now());
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000);
      }
    }
    const audio = this.audio;
    this.audio = null;
    await audio?.close();
  }

  private openLane(stage: StageName, at: number): void {
    if (this.lanes.has(stage)) return;
    this.lanes.set(stage, at);
    this.deps.bus.emit({ type: "stage-start", stage, at });
  }

  private closeLane(stage: StageName, at: number): void {
    const started = this.lanes.get(stage);
    if (started === undefined) return;
    this.lanes.delete(stage);
    this.deps.bus.emit({ type: "stage-end", stage, at, ttfbMs: 0 });
    this.metrics.stages[stage] = (this.metrics.stages[stage] ?? 0) + (at - started);
  }

  private openStage(next: StageName): void {
    const now = performance.now();
    if (this.stage === next) return;
    if (this.stage) {
      this.deps.bus.emit({ type: "stage-end", stage: this.stage, at: now, ttfbMs: 0 });
      this.metrics.stages[this.stage] =
        (this.metrics.stages[this.stage] ?? 0) + (now - this.stageAt);
      if (next === "capture") {
        this.deps.onTurn(this.metrics);
        this.resetTurn();
      }
    }
    this.deps.bus.emit({ type: "stage-start", stage: next, at: now });
    this.stageAt = now;
    this.stage = next;
  }

  private closeAllLanes(at: number): void {
    for (const stage of [...this.lanes.keys()]) this.closeLane(stage, at);
    if (this.stage) {
      this.deps.bus.emit({ type: "stage-end", stage: this.stage, at, ttfbMs: 0 });
      this.stage = null;
    }
  }

  private resetTurn(): void {
    this.metrics = { stages: {}, llmTokens: 0, ttsChars: 0 };
    this.lanes.clear();
  }
}
