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
  ["E", "eеэeэ"],
  ["O", "oоё"],
  ["U", "uую"],
  // Other consonants close the mouth too, but not all the way to rest: the L shape
  // is closest to how they are articulated and doesn't drop the jaw fully.
  ["L", "gгkкxхhчшщжrрvj"],
];

const MAP = new Map<string, Viseme>();
for (const [viseme, chars] of GROUPS) {
  for (const ch of chars) if (!MAP.has(ch)) MAP.set(ch, viseme);
}

/**
 * `rest` only on a real pause (space, punctuation). Any unknown consonant used to
 * land here too, so the mouth slammed shut between syllables ~15 times a second
 * and the animation read as twitching rather than speech.
 */
export function charToViseme(ch: string): Viseme {
  return MAP.get(ch.toLowerCase()) ?? "rest";
}

/** Accumulates an absolute mouth timeline from TTS chunks. */
export class VisemeTimeline {
  private frames: VisemeFrame[] = [];
  private offsetMs = 0;

  get totalMs(): number {
    return this.offsetMs;
  }

  /**
   * @param audioMs how long this chunk's audio actually plays. This, not the
   * alignment, is what advances the timeline: alignment covers only the characters it
   * describes, so anchoring to it left the mouth ahead of the voice by the difference
   * — and the error accumulated with every chunk.
   */
  append(chunk: TtsChunk, audioMs = 0): void {
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

    // The audio's own length wins when we know it: the timeline has to track the
    // sound. Falls back to the alignment only when the chunk's duration is unknown.
    this.offsetMs += audioMs > 0 ? audioMs : chunkEnd;
  }

  /**
   * Appends alignment whose timings are already absolute, as ElevenLabs Agents reports
   * them. The chunk-based `append` cannot be used there: with Agents we never see the
   * audio, so there is no chunk length to advance an offset by.
   */
  appendAbsolute(chars: string[], startMs: number[], durationMs: number[]): void {
    for (let i = 0; i < chars.length; i++) {
      const start = startMs[i] ?? 0;
      const dur = durationMs[i] ?? 0;
      this.frames.push({
        viseme: charToViseme(chars[i]),
        startMs: start,
        endMs: start + dur,
      });
      this.offsetMs = Math.max(this.offsetMs, start + dur);
    }
  }

  at(elapsedMs: number): Viseme {
    // Hundreds of frames per phrase: a linear scan from the end is enough and simpler than binary search.
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
