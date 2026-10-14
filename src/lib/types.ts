export type StageName = "capture" | "vad" | "stt" | "llm" | "tts" | "playback";

export const STAGE_ORDER: readonly StageName[] = [
  "capture", "vad", "stt", "llm", "tts", "playback",
] as const;

/** Per-stage TTFB + usage for one conversational turn. Shape carried over from voice-poc. */
export interface TurnMetrics {
  stages: Partial<Record<StageName, number>>;
  llmTokens: number;
  ttsChars: number;
}

export interface SttWord {
  text: string;
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  /** 0..1. Scribe reports it per word, not per phrase. */
  confidence: number;
}

export interface SttResult {
  text: string;
  words: SttWord[];
}

export type PipelineEvent =
  | { type: "turn-start"; at: number }
  | { type: "stage-start"; stage: StageName; at: number }
  | { type: "stage-end"; stage: StageName; at: number; ttfbMs: number }
  | { type: "stage-error"; stage: StageName; at: number; message: string }
  | { type: "stt-result"; result: SttResult }
  // `at` is mandatory: without it token rate is measured by arrival time,
  // i.e. by the transport rather than by the model.
  | { type: "llm-token"; token: string; at: number }
  /** A complete agent reply, for providers that report it as one message. */
  | { type: "agent-reply"; text: string; at: number }
  // Input audio level, ~100 Hz. Emitted by capture with a live mic; offline there
  // are no such events and the scene shows 0.
  | { type: "audio-level"; rms: number; at: number }
  | { type: "turn-end"; at: number; metrics: TurnMetrics }
  // How a mistake reaches the screen. The tutor does not draw and the scene does not
  // know the tutor exists, exactly as the pipeline and the scene do not know each
  // other — a new fact travels as an event or not at all.
  | {
      type: "mistake";
      /** What the recogniser heard. */
      said: string;
      /** The same sentence with every rule that fired applied. */
      fixed: string;
      /** Human-readable rule names, so the scene needs nothing from the tutor. */
      labels: string[];
      /** Mistakes recorded so far, so the counter cannot drift from the list. */
      total: number;
      at: number;
    }
  // The record was wiped by the learner. Carries no payload: there is nothing left to
  // describe, and the board has only to empty itself.
  | { type: "mistakes-cleared"; at: number }
  // The learner's level, for the one control that can change it. `null` is a reset:
  // the level is gone and the agent will ask again.
  | {
      type: "level";
      level: string | null;
      /** Whether the learner said so, or it was judged from their English. */
      told: boolean;
      at: number;
    };
