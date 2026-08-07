import type { TtsChunk } from "../types";
import type { Transport } from "../transport";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: (() => void) | null;
}

export type SocketFactory = (url: string) => WebSocketLike;

export interface TtsDeps {
  transport: Transport;
  voiceId?: string;
  socketFactory?: SocketFactory;
}

const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const MODEL = "eleven_flash_v2_5";

interface ServerAlignment {
  chars: string[];
  charStartTimesMs: number[];
  charDurationsMs: number[];
}

interface ServerFrame {
  audio?: string | null;
  alignment?: ServerAlignment | null;
  normalizedAlignment?: ServerAlignment | null;
  isFinal?: boolean;
}

function decodePcm(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

export async function* synthesize(text: string, deps: TtsDeps): AsyncIterable<TtsChunk> {
  const token = await deps.transport.ttsToken();
  const voice = deps.voiceId ?? DEFAULT_VOICE;
  // `single_use_token`, not `authorization`: the socket closes with 1008 on the
  // latter ("none of the authentication methods were found"), so live speech never
  // worked. The offline fixtures skip this socket, which is why tests stayed green.
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/stream-input` +
    `?model_id=${MODEL}&output_format=pcm_16000&single_use_token=${encodeURIComponent(token)}`;

  const make = deps.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
  const ws = make(url);

  const queue: TtsChunk[] = [];
  let done = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const signal = () => {
    wake?.();
    wake = null;
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 } }));
    ws.send(JSON.stringify({ text }));
    ws.send(JSON.stringify({ text: "" })); // an empty string closes the input
  };

  ws.onmessage = (ev) => {
    const frame = JSON.parse(ev.data) as ServerFrame;
    const a = frame.normalizedAlignment ?? frame.alignment;
    if (frame.audio && a) {
      queue.push({
        audio: decodePcm(frame.audio),
        chars: a.chars,
        charStartTimesMs: a.charStartTimesMs,
        charDurationsMs: a.charDurationsMs,
      });
    }
    if (frame.isFinal) done = true;
    signal();
  };

  ws.onerror = () => {
    failure = new Error("tts socket failed");
    done = true;
    signal();
  };

  ws.onclose = () => {
    done = true;
    signal();
  };

  try {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (failure) throw failure;
      if (done) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    ws.close();
  }
}
