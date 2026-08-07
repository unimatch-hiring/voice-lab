import { Conversation } from "@elevenlabs/client";
import type { EventBus } from "../events";
import type { Transport } from "../transport";
import type { StageName, TurnMetrics } from "../types";

export interface AgentSessionDeps {
  bus: EventBus;
  transport: Transport;
  /** Character timings for the mouth, in absolute milliseconds from the reply's start. */
  onAlignment: (chars: string[], startMs: number[], durationMs: number[]) => void;
  /** Called when a turn completes, with what each stage cost. */
  onTurn: (metrics: TurnMetrics) => void;
  /** The agent started or stopped speaking — the mouth's clock runs off this. */
  onSpeaking: (speaking: boolean) => void;
  /**
   * The conversation ended. `reason` says who ended it: the user pressed stop, the agent
   * decided it was done, or the connection failed.
   */
  onEnded: (reason: "user" | "agent" | "error", message?: string) => void;
}

/**
 * Translates ElevenLabs Agents events into the stage stream the scene draws.
 * Stage mapping and turn boundaries: docs/pipeline.md
 */
/** Detector score above which the vad lane counts as open. */
const VAD_SPEECH = 0.5;

// The SDK resamples 100-8000 Hz linearly across 1024 bins, so bin i is
// 100 + (i / 1024) * 7900 Hz — independent of sample rate and FFT size.
const JAW_BIN_FROM = 13; // ~200 Hz
const JAW_BIN_TO = 104; // ~900 Hz
const SIBILANT_BIN_FROM = 376; // ~3 kHz
/** How strongly sibilant energy closes the mouth. */
const SIBILANT_CLOSE = 0.6;

export class AgentSession {
  private conversation: Awaited<ReturnType<typeof Conversation.startSession>> | null = null;
  private running = false;

  /** When the current stage opened, so its duration can be reported on close. */
  private stageAt = 0;
  private stage: StageName | null = null;
  private metrics: TurnMetrics = { stages: {}, llmTokens: 0, ttsChars: 0 };
  /** Absolute offset for alignment, so the mouth follows a multi-chunk reply. */
  private replyMs = 0;
  /** Reply text already shown token by token, so the final message is not repeated. */
  private streamedReply = "";
  /** Lanes opened outside the mode machine — vad, stt and tts overlap the main stages. */
  private lanes = new Map<StageName, number>();
  private vadOpen = false;

  constructor(private deps: AgentSessionDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * How far the mouth should be open, 0..1, from the spectrum of the audio playing.
   * Bins are a linear resample of 100-8000 Hz across 1024 slots, not raw FFT bins.
   * Band choice and why not plain loudness: docs/mouth.md
   */
  outputLevel(): number {
    const spectrum = this.conversation?.getOutputByteFrequencyData();
    if (!spectrum || spectrum.length === 0) {
      return this.conversation?.getOutputVolume() ?? 0;
    }

    const band = (from: number, to: number): number => {
      const lo = Math.min(spectrum.length - 1, from);
      const hi = Math.min(spectrum.length, to);
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += spectrum[i];
      return hi > lo ? sum / (hi - lo) / 255 : 0;
    };

    const jaw = band(JAW_BIN_FROM, JAW_BIN_TO);
    const sibilant = band(SIBILANT_BIN_FROM, spectrum.length);

    // Sibilants are energetic but nearly closed, so they subtract.
    return Math.max(0, jaw - sibilant * SIBILANT_CLOSE);
  }

  async start(): Promise<void> {
    if (this.running) return;

    const { token } = await this.deps.transport.agentToken();
    this.resetTurn();

    this.conversation = await Conversation.startSession({
      conversationToken: token,

      onModeChange: ({ mode }) => {
        // `Mode` is only "speaking" | "listening" — there is no third value, so the model's
        // stage has to be bracketed from other events (see onMessage / onAudio).
        const next: StageName | null = mode === "listening" ? "capture" : "playback";
        this.deps.onSpeaking(mode === "speaking");
        if (mode !== "speaking") this.closeLane("tts", performance.now());
        this.openStage(next);
      },

      onVadScore: ({ vadScore }) => {
        const at = performance.now();
        this.deps.bus.emit({ type: "audio-level", rms: vadScore, at });
        const speech = vadScore >= VAD_SPEECH;
        if (speech && !this.vadOpen) {
          this.vadOpen = true;
          this.openLane("vad", at);
        } else if (!speech && this.vadOpen) {
          this.vadOpen = false;
          this.closeLane("vad", at);
        }
      },

      onAsrInitiationMetadata: () => {
        this.openLane("stt", performance.now());
      },

      onMessage: ({ message, source }) => {
        if (source === "user") {
          const at = performance.now();
          this.closeLane("stt", at);
          // Recognition is done, so the model is now working: the lane runs until audio
          // starts coming back.
          this.openLane("llm", at);
          this.deps.bus.emit({
            type: "stt-result",
            result: { text: message, words: [] },
          });
          return;
        }

        // `onAgentChatResponsePart` streams the reply earlier but is experimental and does
        // not always fire, so this is the source of record.
        this.metrics.ttsChars += message.length;
        if (this.streamedReply.trim() === message.trim()) {
          this.streamedReply = "";
          return;
        }
        this.streamedReply = "";
        this.deps.bus.emit({ type: "agent-reply", text: message, at: performance.now() });
      },

      onAgentChatResponsePart: (part) => {
        const text = part?.text ?? "";
        if (!text) return;
        this.streamedReply += text;
        this.metrics.llmTokens += 1;
        this.deps.bus.emit({ type: "llm-token", token: text, at: performance.now() });
      },

      onAudio: () => {
        const at = performance.now();
        this.closeLane("llm", at);
        this.openLane("tts", at);
      },

      onAudioAlignment: (alignment) => {
        // snake_case here, unlike the rest of the SDK's surface.
        const chars = alignment?.chars ?? [];
        const starts = alignment?.char_start_times_ms ?? [];
        const durations = alignment?.char_durations_ms ?? [];
        if (chars.length === 0) return;

        this.deps.onAlignment(
          chars,
          starts.map((ms: number) => this.replyMs + ms),
          durations,
        );
        // Max end, not the last element: the last character need not end latest, and the
        // error would accumulate across chunks.
        let end = 0;
        for (let i = 0; i < starts.length; i++) {
          end = Math.max(end, (starts[i] ?? 0) + (durations[i] ?? 0));
        }
        this.replyMs += end;
      },

      onInterruption: () => {
        // A new reply starts from zero, so the mouth's clock has to as well.
        this.replyMs = 0;
      },

      onDisconnect: (details) => {
        this.running = false;
        this.closeAllLanes(performance.now());
        this.deps.onEnded(
          details.reason,
          details.reason === "error" ? details.message : undefined,
        );
      },

      onError: (message) => {
        this.deps.bus.emit({
          type: "stage-error",
          stage: this.stage ?? "stt",
          at: performance.now(),
          message,
        });
      },
    });

    this.running = true;
  }

  /** Lanes overlap the mode-driven stage, so they cannot share its single slot. */
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

  /** Closes the previous stage, reporting its duration, and opens the next one. */
  private openStage(next: StageName | null): void {
    const now = performance.now();

    if (this.stage && this.stage !== next) {
      this.deps.bus.emit({ type: "stage-end", stage: this.stage, at: now, ttfbMs: 0 });
      this.metrics.stages[this.stage] =
        (this.metrics.stages[this.stage] ?? 0) + (now - this.stageAt);

      if (next === "capture") {
        this.deps.onTurn(this.metrics);
        this.resetTurn();
      }
    }

    if (next && this.stage !== next) {
      this.deps.bus.emit({ type: "stage-start", stage: next, at: now });
      this.stageAt = now;
    }
    this.stage = next;
  }

  /** Nothing may stay open after a disconnect. */
  private closeAllLanes(at: number): void {
    for (const stage of [...this.lanes.keys()]) this.closeLane(stage, at);
    if (this.stage) {
      this.deps.bus.emit({ type: "stage-end", stage: this.stage, at, ttfbMs: 0 });
      this.stage = null;
    }
    this.vadOpen = false;
  }

  private resetTurn(): void {
    this.metrics = { stages: {}, llmTokens: 0, ttsChars: 0 };
    this.replyMs = 0;
    this.lanes.clear();
    this.vadOpen = false;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.closeAllLanes(performance.now());
    const conversation = this.conversation;
    this.conversation = null;
    await conversation?.endSession().catch(() => undefined);
  }
}
