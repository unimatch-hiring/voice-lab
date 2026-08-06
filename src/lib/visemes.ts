import type { TtsChunk } from "./types";

export type Viseme = "rest" | "MBP" | "AI" | "E" | "O" | "U" | "FV" | "L" | "WQ";

export interface VisemeFrame {
  viseme: Viseme;
  startMs: number;
  endMs: number;
}

const GROUPS: Array<[Viseme, string]> = [
  ["MBP", "mbpмбп"],
  ["FV", "fvфв"],
  ["L", "lлнdtдтzсsзц"],
  ["WQ", "wq"],
  ["AI", "aiаяиый"],
  ["E", "eеэ"],
  ["O", "oоё"],
  ["U", "uую"],
];

const MAP = new Map<string, Viseme>();
for (const [viseme, chars] of GROUPS) {
  for (const ch of chars) if (!MAP.has(ch)) MAP.set(ch, viseme);
}

export function charToViseme(ch: string): Viseme {
  return MAP.get(ch.toLowerCase()) ?? "rest";
}

/** Копит абсолютный таймлайн рта из чанков TTS. */
export class VisemeTimeline {
  private frames: VisemeFrame[] = [];
  private offsetMs = 0;

  get totalMs(): number {
    return this.offsetMs;
  }

  append(chunk: TtsChunk): void {
    let chunkEnd = 0;

    for (let i = 0; i < chunk.chars.length; i++) {
      const start = chunk.charStartTimesMs[i] ?? 0;
      const dur = chunk.charDurationsMs[i] ?? 0;
      chunkEnd = Math.max(chunkEnd, start + dur);

      this.frames.push({
        viseme: charToViseme(chunk.chars[i]),
        startMs: this.offsetMs + start,
        endMs: this.offsetMs + start + dur,
      });
    }

    this.offsetMs += chunkEnd;
  }

  at(elapsedMs: number): Viseme {
    // Кадров на фразу — сотни, линейного поиска с конца достаточно и он проще бинарного.
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (elapsedMs >= f.startMs && elapsedMs < f.endMs) return f.viseme;
    }
    return "rest";
  }

  reset(): void {
    this.frames = [];
    this.offsetMs = 0;
  }
}
