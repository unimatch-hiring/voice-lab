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
 * Stages that read a recorded turn instead of the network. They plug into the same
 * Orchestrator as the live ones, so an offline run exercises the real code path
 * rather than a separate "demo mode" branch.
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
