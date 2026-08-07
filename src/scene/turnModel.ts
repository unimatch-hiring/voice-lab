import type { PipelineEvent, StageName } from "../lib/types";

export interface Span {
  stage: StageName;
  start: number;
  end: number | null;
}

export class TurnModel {
  private spans: Span[] = [];
  private open = new Map<StageName, Span>();
  private tokenCount = 0;
  private rms = 0;

  get tokens(): number {
    return this.tokenCount;
  }

  get level(): number {
    return this.rms;
  }

  /** The latest-started open span — on overlap it is the more informative one. */
  get activeStage(): StageName | null {
    let best: Span | null = null;
    for (const span of this.open.values()) {
      if (!best || span.start > best.start) best = span;
    }
    return best?.stage ?? null;
  }

  apply(e: PipelineEvent): void {
    switch (e.type) {
      case "stage-start": {
        const prev = this.open.get(e.stage);
        if (prev && prev.end === null) prev.end = e.at;
        const span: Span = { stage: e.stage, start: e.at, end: null };
        this.open.set(e.stage, span);
        this.spans.push(span);
        break;
      }
      case "stage-end": {
        const span = this.open.get(e.stage);
        if (span) span.end = e.at;
        this.open.delete(e.stage);
        break;
      }
      case "stage-error": {
        const span = this.open.get(e.stage);
        if (span) span.end = e.at;
        this.open.delete(e.stage);
        break;
      }
      case "llm-token":
        this.tokenCount++;
        break;
      case "audio-level":
        this.rms = e.rms;
        break;
      case "turn-start":
        this.tokenCount = 0;
        break;
      default:
        break;
    }
  }

  /** Drops spans that have scrolled entirely past the left edge of the window. */
  prune(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    if (this.spans.length === 0) return;
    this.spans = this.spans.filter((s) => (s.end ?? Infinity) >= cutoff);
  }

  visible(now: number, windowMs: number): Span[] {
    const cutoff = now - windowMs;
    return this.spans.filter((s) => (s.end ?? now) >= cutoff);
  }

  reset(): void {
    this.spans = [];
    this.open.clear();
    this.tokenCount = 0;
    this.rms = 0;
  }
}
