import type { EventBus } from "./events";
import type { PipelineEvent, TurnMetrics } from "./types";

/**
 * Records conversations off the event stream so we can export them as fixtures.
 *
 * This exists for us, not for the product: analysing a conversation away from the
 * microphone needs a recording of one, and there is no other way to produce it. It
 * subscribes to the bus like the scene does and never touches the pipeline.
 */

export interface RecordedLine {
  speaker: "user" | "agent";
  text: string;
  /** Milliseconds from the start of the recording, so a fixture reads as a timeline. */
  atMs: number;
}

export interface RecordedConversation {
  id: string;
  startedAt: number;
  lines: RecordedLine[];
  /** One entry per completed turn, in order. */
  turns: TurnMetrics[];
}

/** The transcript line a bus event carries, or null when it carries none (other events, blank text). */
export function lineFromEvent(e: PipelineEvent, atMs: number): RecordedLine | null {
  let speaker: RecordedLine["speaker"];
  let text: string;
  if (e.type === "stt-result") {
    speaker = "user";
    text = e.result.text;
  } else if (e.type === "agent-reply") {
    speaker = "agent";
    text = e.text;
  } else {
    return null;
  }

  const trimmed = text.trim();
  return trimmed ? { speaker, text: trimmed, atMs } : null;
}

export class Recorder {
  private lines: RecordedLine[] = [];
  private turns: TurnMetrics[] = [];
  private startedAt = 0;
  private origin = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private bus: EventBus,
    private now: () => number = () => performance.now(),
    private wallClock: () => number = () => Date.now(),
  ) {}

  get isRecording(): boolean {
    return this.unsubscribe !== null;
  }

  /** Line count rather than the lines themselves: the UI only needs to show progress. */
  get lineCount(): number {
    return this.lines.length;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.lines = [];
    this.turns = [];
    this.startedAt = this.wallClock();
    this.origin = this.now();

    this.unsubscribe = this.bus.on((e) => {
      const line = lineFromEvent(e, 0);
      if (!line) return;
      this.lines.push({ ...line, atMs: Math.round(this.now() - this.origin) });
    });
  }

  /**
   * Completed turns arrive through the session's `onTurn` callback rather than the bus —
   * `turn-end` is declared in the event union but nothing emits it — so the caller hands
   * them over. Recording metrics off a `turn-end` subscription would silently record none.
   */
  addTurn(metrics: TurnMetrics): void {
    if (this.unsubscribe) this.turns.push(metrics);
  }

  /** Returns the recording, or null if nothing happened — an empty fixture is not worth keeping. */
  stop(): RecordedConversation | null {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.lines.length === 0 && this.turns.length === 0) return null;

    return {
      // Wall-clock start, so two fixtures recorded in one session sort and name themselves.
      id: new Date(this.startedAt).toISOString().replace(/[:.]/g, "-"),
      startedAt: this.startedAt,
      lines: this.lines,
      turns: this.turns,
    };
  }
}

/** Pretty-printed: these files are read by a human before they are read by a candidate. */
export function toFixtureJson(conversation: RecordedConversation): string {
  return `${JSON.stringify(conversation, null, 2)}\n`;
}

export function fixtureFilename(conversation: RecordedConversation): string {
  return `conversation-${conversation.id}.json`;
}
