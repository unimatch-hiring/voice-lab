import type { SttResult, TtsChunk } from "../types";
import type { LlmMessage } from "../transport";

export interface Fixture {
  id: string;
  label: string;
  stt: SttResult;
  reply: string;
  chunks: TtsChunk[];
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Стадии, читающие записанный turn вместо сети. Подставляются в тот же
 * Orchestrator, что и живые, — поэтому оффлайн-прогон проверяет реальный код,
 * а не отдельную ветку «для демо».
 */
export function offlineStages(fixture: Fixture, delayMs = 120) {
  return {
    transcribe: async (_audio: Blob): Promise<SttResult> => {
      await sleep(delayMs);
      return fixture.stt;
    },

    respond: async function* (_text: string, _opts: { history: LlmMessage[] }) {
      for (const word of fixture.reply.split(/(\s+)/)) {
        if (!word) continue;
        await sleep(delayMs / 8);
        yield word;
      }
    },

    synthesize: async function* (_text: string) {
      for (const chunk of fixture.chunks) {
        await sleep(delayMs / 4);
        yield chunk;
      }
    },
  };
}
