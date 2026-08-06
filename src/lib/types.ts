export type StageName = "capture" | "vad" | "stt" | "llm" | "tts" | "playback";

export const STAGE_ORDER: readonly StageName[] = [
  "capture", "vad", "stt", "llm", "tts", "playback",
] as const;

/** Per-stage TTFB + usage за один conversational turn. Форма из voice-poc. */
export interface TurnMetrics {
  stages: Partial<Record<StageName, number>>;
  llmTokens: number;
  ttsChars: number;
}

export interface SttWord {
  text: string;
  /** Секунды от начала аудио. */
  start: number;
  end: number;
  /** 0..1. Scribe отдаёт на слово, не на фразу. */
  confidence: number;
}

export interface SttResult {
  text: string;
  words: SttWord[];
}

/** Чанк от websocket TTS: аудио + посимвольная раскладка времени. */
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
  // at обязателен: без него скорость токенов меряется временем прибытия,
  // то есть транспортом, а не моделью.
  | { type: "llm-token"; token: string; at: number }
  // Уровень входного аудио, ~100 Гц. Эмитит capture при живом микрофоне;
  // в оффлайн-режиме событий нет, сцена показывает 0.
  | { type: "audio-level"; rms: number; at: number }
  | { type: "tts-chunk"; chunk: TtsChunk; offsetMs: number }
  | { type: "turn-end"; at: number; metrics: TurnMetrics };
