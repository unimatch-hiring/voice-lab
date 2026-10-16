import type { EventBus } from "../events";
import type { Transport } from "../transport";
import type { TurnMetrics } from "../types";

/** Which managed service runs the conversation. Chosen per key, in the admin page. */
export type Engine = "elevenlabs" | "deepgram";

export interface SessionDeps {
  bus: EventBus;
  transport: Transport;
  /**
   * Material for what the person just said, or null. ElevenLabs gets it as a contextual
   * update, which lands after the server has started the reply to those words, so it
   * informs the turns after. Deepgram ignores it.
   */
  knowledgeFor?: (words: string) => string | null;
  /** Called when a turn completes, with what each stage cost. */
  onTurn: (metrics: TurnMetrics) => void;
  /**
   * The conversation ended. `reason` says who ended it: the user pressed stop, the agent
   * decided it was done, or the connection failed.
   */
  onEnded: (reason: "user" | "agent" | "error", message?: string) => void;
}

/** What the page drives, whichever engine is underneath. */
export interface VoiceSession {
  readonly isRunning: boolean;
  /** The spectrum of the audio playing right now, or null when nothing is. */
  mouthSpectrum(): Uint8Array | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}
