import type { PipelineEvent, SttResult, StageName, TtsChunk, TurnMetrics } from "../types";
import type { EventBus } from "../events";
import type { LlmMessage } from "../transport";
import { VisemeTimeline } from "../visemes";

export type TranscribeFn = (audio: Blob) => Promise<SttResult>;
export type RespondFn = (text: string, opts: { history: LlmMessage[] }) => AsyncIterable<string>;
export type SynthesizeFn = (text: string) => AsyncIterable<TtsChunk>;

export interface PlaybackLike {
  enqueue(chunk: TtsChunk): void;
  stop(): void;
  readonly elapsedMs: number;
  readonly isPlaying: boolean;
}

export interface OrchestratorDeps {
  bus: EventBus;
  transcribe: TranscribeFn;
  respond: RespondFn;
  synthesize: SynthesizeFn;
  playback: PlaybackLike;
  now?: () => number;
}

export class Orchestrator {
  readonly timeline = new VisemeTimeline();
  private conversation: LlmMessage[] = [];
  private readonly now: () => number;

  constructor(private deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  get history(): LlmMessage[] {
    return this.conversation;
  }

  reset(): void {
    this.conversation = [];
    this.timeline.reset();
    this.deps.playback.stop();
  }

  private emit(e: PipelineEvent): void {
    this.deps.bus.emit(e);
  }

  /** Runs a stage, times it and records the TTFB into the metrics. */
  private async stage<T>(name: StageName, metrics: TurnMetrics, fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    this.emit({ type: "stage-start", stage: name, at: started });
    try {
      const result = await fn();
      const at = this.now();
      metrics.stages[name] = at - started;
      this.emit({ type: "stage-end", stage: name, at, ttfbMs: at - started });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "stage-error", stage: name, at: this.now(), message });
      throw err;
    }
  }

  async runTurn(audio: Blob): Promise<TurnMetrics> {
    const metrics: TurnMetrics = { stages: {}, llmTokens: 0, ttsChars: 0 };
    this.timeline.reset();
    this.emit({ type: "turn-start", at: this.now() });

    const stt = await this.stage("stt", metrics, () => this.deps.transcribe(audio));
    this.emit({ type: "stt-result", result: stt });

    const reply = await this.stage("llm", metrics, async () => {
      let text = "";
      for await (const token of this.deps.respond(stt.text, { history: [...this.conversation] })) {
        text += token;
        metrics.llmTokens++;
        this.emit({ type: "llm-token", token, at: this.now() });
      }
      return text;
    });

    const chunks = await this.stage("tts", metrics, async () => {
      const collected: TtsChunk[] = [];
      for await (const chunk of this.deps.synthesize(reply)) {
        metrics.ttsChars += chunk.chars.length;
        this.emit({ type: "tts-chunk", chunk, offsetMs: this.timeline.totalMs });
        this.timeline.append(chunk);
        collected.push(chunk);
      }
      return collected;
    });

    await this.stage("playback", metrics, async () => {
      for (const chunk of chunks) this.deps.playback.enqueue(chunk);
    });

    this.conversation.push({ role: "user", content: stt.text });
    this.conversation.push({ role: "assistant", content: reply });

    this.emit({ type: "turn-end", at: this.now(), metrics });
    return metrics;
  }
}
