export type VadEvent = "speech-start" | "speech-end";

export interface VadOptions {
  threshold?: number;
  /** How many consecutive quiet frames count as end of speech. A short pause is not the end. */
  hangoverFrames?: number;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export class EnergyVad {
  private speaking = false;
  private quietFrames = 0;
  private readonly threshold: number;
  private readonly hangoverFrames: number;

  constructor(opts: VadOptions = {}) {
    this.threshold = opts.threshold ?? 0.02;
    this.hangoverFrames = opts.hangoverFrames ?? 12;
  }

  push(samples: Float32Array): VadEvent | null {
    const loud = rms(samples) >= this.threshold;

    if (loud) {
      this.quietFrames = 0;
      if (!this.speaking) {
        this.speaking = true;
        return "speech-start";
      }
      return null;
    }

    if (!this.speaking) return null;

    this.quietFrames++;
    if (this.quietFrames >= this.hangoverFrames) {
      this.speaking = false;
      this.quietFrames = 0;
      return "speech-end";
    }
    return null;
  }

  reset(): void {
    this.speaking = false;
    this.quietFrames = 0;
  }
}
