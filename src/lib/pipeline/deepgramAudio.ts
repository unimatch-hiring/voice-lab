import { resampleToSdkLayout } from "../mouthLevel";

/** What DeepgramSession needs from the audio hardware; the browser one is below. */
export interface DeepgramAudio {
  /** Sample rate the microphone frames are captured at, for the Settings message. */
  readonly inputRate: number;
  /** Opens the microphone. Frames are 16-bit PCM, with their RMS for the level meter. */
  start(onFrame: (pcm: ArrayBuffer, rms: number) => void): Promise<void>;
  /** Queues 16-bit PCM from the agent for gapless playback. */
  play(pcm: ArrayBuffer): void;
  /** Drops everything queued and playing: the user talked over the agent. */
  flush(): void;
  isPlaying(): boolean;
  /** Called when the playback queue runs empty. */
  onDrained: (() => void) | null;
  /** Spectrum of what is playing, in the layout `mouthLevel` reads. */
  spectrum(): Uint8Array | null;
  close(): Promise<void>;
}

export const OUTPUT_RATE = 24000;

/** ~20 ms of audio per socket frame: small enough for latency, large enough not to flood. */
const FRAME_MS = 20;

// Inline so there is no extra file to serve; the worklet only forwards samples.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("dg-tap", Tap);
`;

function toPcm16(samples: Float32Array): { pcm: ArrayBuffer; rms: number } {
  const out = new Int16Array(samples.length);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    sum += s * s;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return { pcm: out.buffer, rms: Math.sqrt(sum / Math.max(1, samples.length)) };
}

/**
 * Microphone and speaker on ONE AudioContext: browser echo cancellation only covers
 * output from the same context, otherwise the agent hears itself (docs/pipeline.md).
 */
export function createBrowserAudio(): DeepgramAudio {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.connect(ctx.destination);
  const fft = new Uint8Array(analyser.frequencyBinCount);

  let stream: MediaStream | null = null;
  let nextAt = 0;
  const playing = new Set<AudioBufferSourceNode>();

  const audio: DeepgramAudio = {
    inputRate: ctx.sampleRate,
    onDrained: null,

    async start(onFrame) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      await ctx.resume();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const source = ctx.createMediaStreamSource(stream);
      const tap = new AudioWorkletNode(ctx, "dg-tap");
      const frameLen = Math.round((ctx.sampleRate * FRAME_MS) / 1000);
      let pending = new Float32Array(frameLen);
      let filled = 0;
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
        for (const sample of e.data) {
          pending[filled++] = sample;
          if (filled === frameLen) {
            const { pcm, rms } = toPcm16(pending);
            onFrame(pcm, rms);
            pending = new Float32Array(frameLen);
            filled = 0;
          }
        }
      };
      source.connect(tap);
    },

    play(pcm) {
      const ints = new Int16Array(pcm);
      if (ints.length === 0) return;
      const buffer = ctx.createBuffer(1, ints.length, OUTPUT_RATE);
      const ch = buffer.getChannelData(0);
      for (let i = 0; i < ints.length; i++) ch[i] = ints[i] / 0x8000;

      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(analyser);
      // A chunk that arrives after the queue drained must not land at "now" mid-gap,
      // or replies stutter; a 50 ms head start keeps chunks back to back.
      nextAt = Math.max(nextAt, ctx.currentTime + 0.05);
      node.start(nextAt);
      nextAt += buffer.duration;
      playing.add(node);
      node.onended = () => {
        playing.delete(node);
        if (playing.size === 0) audio.onDrained?.();
      };
    },

    flush() {
      for (const node of playing) {
        node.onended = null;
        node.stop();
      }
      playing.clear();
      nextAt = 0;
    },

    isPlaying: () => playing.size > 0,

    spectrum() {
      if (playing.size === 0) return null;
      analyser.getByteFrequencyData(fft);
      return resampleToSdkLayout(fft, ctx.sampleRate);
    },

    async close() {
      audio.flush();
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
      await ctx.close().catch(() => undefined);
    },
  };
  return audio;
}
