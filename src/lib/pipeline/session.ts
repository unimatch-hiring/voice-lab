import type { EventBus } from "../events";
import type { Transport } from "../transport";
import type { TurnMetrics } from "../types";

/** Which managed service runs the conversation. Chosen per key, in the admin page. */
export type Engine = "elevenlabs" | "deepgram";

export interface SessionDeps {
  bus: EventBus;
  transport: Transport;
  /** Called when a turn completes, with what each stage cost. */
  onTurn: (metrics: TurnMetrics) => void;
  /**
   * The conversation ended. `reason` says who ended it: the user pressed stop, the agent
   * decided it was done, or the connection failed.
   */
  onEnded: (reason: "user" | "agent" | "error", message?: string) => void;
  functions?: ClientFunction[];
  /** What the page already knows about the customer, read at start and added to the role. */
  briefing?: () => string;
  /** The agent's first line, read at start; it may depend on who is on file. */
  greeting?: () => string;
}

/** A function the agent may call; it runs here in the page, not on the engine's side. */
export interface ClientFunction {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** The result goes back to the model as text. */
  run(args: Record<string, unknown>): string | Promise<string>;
}

/** What the page drives, whichever engine is underneath. */
export interface VoiceSession {
  readonly isRunning: boolean;
  /** The spectrum of the audio playing right now, or null when nothing is. */
  mouthSpectrum(): Uint8Array | null;
  /** Silent context the agent takes into account from its next reply on. */
  sendContextualUpdate(text: string): void;
  /** A typed user turn: the agent answers it right away. */
  sendUserMessage(text: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The role plus what is already on file. It goes into the prompt rather than a contextual
 * update because the greeting is generated before any update can arrive.
 */
export function withBriefing(role: string, briefing = ""): string {
  return briefing ? `${role}\n\n${briefing}` : role;
}
