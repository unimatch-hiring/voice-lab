export type StageName =
  | "capture" | "vad" | "stt" | "llm" | "tts" | "playback"
  // The layered loop. ElevenLabs owns the turn, so none of these can pre-empt a reply:
  // they run beside one that has already started. docs/layers.md
  | "gate" | "recall" | "archive";

export const STAGE_ORDER: readonly StageName[] = [
  "capture", "vad", "stt", "llm", "tts", "playback",
  "gate", "recall", "archive",
] as const;

/**
 * Lanes that run while a reply is already being generated or played.
 *
 * They are drawn, but they are not summed into what the turn cost: an archiver with a
 * four-second budget added to a two-second turn reads as a six-second turn.
 */
export const OFF_PATH: readonly StageName[] = ["gate", "recall", "archive"] as const;

/** Where an utterance sits against the persona's charter. */
export type Scope = "in_scope" | "adjacent" | "out_of_scope" | "injection" | "unknown";

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
  /** B's read of the utterance. `degraded` means B failed and this is the fail-open value. */
  | { type: "gate-verdict"; scope: Scope; needsRecall: boolean; degraded: boolean; at: number }
  | { type: "recall-result"; found: boolean; tier: 1 | 2; at: number }
  | { type: "archive-updated"; facts: number; at: number }
  | { type: "turn-end"; at: number; metrics: TurnMetrics };
