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

/** A chunk from the websocket TTS: audio plus per-character timing. */
export interface TtsChunk {
  audio: Int16Array;
  chars: string[];
  charStartTimesMs: number[];
  charDurationsMs: number[];
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
  | { type: "tts-chunk"; chunk: TtsChunk; offsetMs: number }
  | { type: "turn-end"; at: number; metrics: TurnMetrics };
