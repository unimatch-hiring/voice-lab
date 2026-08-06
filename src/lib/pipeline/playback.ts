import type { TtsChunk } from "../types";

export interface AudioContextLike {
  currentTime: number;
  sampleRate: number;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  destination: unknown;
}

interface AudioBufferLike {
  duration: number;
  getChannelData(channel: number): Float32Array;
}

interface AudioBufferSourceLike {
  buffer: unknown;
  connect(dest: unknown): void;
  start(at: number): void;
  stop(): void;
}

export class PlaybackQueue {
  private nextStartTime = 0;
  private startedAt: number | null = null;
  private sources: AudioBufferSourceLike[] = [];

  constructor(
    private ctx: AudioContextLike,
    private sampleRate = 16000,
  ) {}

  /** Сколько миллисекунд прошло с начала первого чанка. Драйвит анимацию рта. */
  get elapsedMs(): number {
    if (this.startedAt === null) return 0;
    return Math.max(0, (this.ctx.currentTime - this.startedAt) * 1000);
  }

  get isPlaying(): boolean {
    return this.startedAt !== null && this.ctx.currentTime < this.nextStartTime;
  }

  enqueue(chunk: TtsChunk): void {
    const frames = chunk.audio.length;
    if (frames === 0) return;

    const buffer = this.ctx.createBuffer(1, frames, this.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = chunk.audio[i] / 32768;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    // Планируем от конца предыдущего чанка, а не от «сейчас»: иначе щелчки и наложения.
    // Но если очередь давно опустела, догоняем часы контекста, чтобы не играть в прошлое.
    const at = Math.max(this.nextStartTime, this.ctx.currentTime);
    source.start(at);

    if (this.startedAt === null) this.startedAt = at;
    this.nextStartTime = at + buffer.duration;
    this.sources.push(source);
  }

  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // источник мог не начаться — это нормально
      }
    }
    this.sources = [];
    this.nextStartTime = 0;
    this.startedAt = null;
  }
}
