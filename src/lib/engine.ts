import type { Engine } from "./pipeline/session";

export const ENGINE_LABEL: Record<Engine, string> = {
  elevenlabs: "ElevenLabs",
  deepgram: "Deepgram",
};

/** Shown on the main page while the backup engine is on: its voices speak English only. */
export const BACKUP_ENGINE_NOTICE = "Backup engine: English only, Deepgram voice";
