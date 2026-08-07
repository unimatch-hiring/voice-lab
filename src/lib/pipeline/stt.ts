import type { SttResult, SttWord } from "../types";
import type { Transport } from "../transport";

export interface SttDeps {
  transport: Transport;
  /** Always rus for Russian speech: on the default eng, Scribe returns garbage. */
  language?: string;
  fetchImpl?: typeof fetch;
}

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/** logprob (≤0) → 0..1. exp gives the probability, which is exactly what we want to show. */
function toConfidence(logprob: number | undefined): number {
  if (logprob === undefined) return 1;
  return Math.min(1, Math.max(0, Math.exp(logprob)));
}

export async function transcribe(audio: Blob, deps: SttDeps): Promise<SttResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await deps.transport.sttToken();

  const form = new FormData();
  form.set("file", audio);
  form.set("model_id", "scribe_v1");
  form.set("language_code", deps.language ?? "rus");
  form.set("timestamps_granularity", "word");
  form.set("diarize", "false");

  // The single-use token goes in the query string, not in a header. Scribe rejects
  // `authorization: Bearer <sutkn_...>` and `xi-api-key` alike with a 401, so live
  // transcription silently never worked — the offline fixtures do not touch this
  // call, which is why the test suite stayed green.
  const r = await fetchImpl(`${SCRIBE_URL}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) throw new Error(`scribe failed: ${r.status}`);

  const data = (await r.json()) as {
    text: string;
    words?: Array<{ text: string; start: number; end: number; logprob?: number }>;
  };

  const words: SttWord[] = (data.words ?? []).map((w) => ({
    text: w.text,
    start: w.start,
    end: w.end,
    confidence: toConfidence(w.logprob),
  }));

  return { text: data.text, words };
}
