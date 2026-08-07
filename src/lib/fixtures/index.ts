import type { SttResult, TtsChunk } from "../types";
import { offlineStages, type Fixture } from "./offline";

export { offlineStages };
export type { Fixture };

/** Splits a phrase into chunks the way the websocket TTS does: timings inside a chunk are relative to its start. */
function chunksFromText(text: string, msPerChar = 55, charsPerChunk = 40): TtsChunk[] {
  const chunks: TtsChunk[] = [];
  for (let offset = 0; offset < text.length; offset += charsPerChunk) {
    const chars = [...text.slice(offset, offset + charsPerChunk)];
    const starts = chars.map((_, i) => i * msPerChar);
    const durations = chars.map(() => msPerChar);
    const samples = Math.round((chars.length * msPerChar * 16000) / 1000);
    chunks.push({
      audio: new Int16Array(samples),
      chars,
      charStartTimesMs: starts,
      charDurationsMs: durations,
    });
  }
  return chunks;
}

function sttOf(text: string, confidence = 0.95): SttResult {
  const words = text.split(/\s+/).filter(Boolean);
  return {
    text,
    words: words.map((w, i) => ({
      text: w,
      start: i * 0.4,
      end: i * 0.4 + 0.35,
      confidence,
    })),
  };
}

const REPLY_RU = "Привет. Я вижу твой голос: он только что прошёл шесть стадий конвейера.";
const REPLY_EN = "Hi. Your voice just travelled through six pipeline stages.";

export const FIXTURES: Fixture[] = [
  {
    id: "ru-hello",
    label: "Russian phrase, clean recording",
    stt: sttOf("Привет, расскажи, как ты устроен"),
    reply: REPLY_RU,
    chunks: chunksFromText(REPLY_RU),
  },
  {
    id: "en-hello",
    label: "English phrase, clean recording",
    stt: sttOf("Hi, tell me how you work"),
    reply: REPLY_EN,
    chunks: chunksFromText(REPLY_EN),
  },
];
