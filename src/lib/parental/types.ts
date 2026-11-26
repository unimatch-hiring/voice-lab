/** What the parent sets, all free-form text. Mirrors `SETTINGS_FIELDS` in `server/childService.js`. */
export interface ParentSettings {
  allowedTopics: string;
  blockedTopics: string;
  childProfile: string;
  triggerWords: string;
}

export const EMPTY_SETTINGS: ParentSettings = {
  allowedTopics: "",
  blockedTopics: "",
  childProfile: "",
  triggerWords: "",
};

export interface ContextLine {
  role: "child" | "assistant";
  text: string;
}

/** A message that matched an alarm word, sent for review. Mirrors `parseCandidate` on the server. */
export interface FlagCandidate {
  text: string;
  matched: string[];
  context: ContextLine[];
}

/** Stored only when the review confirmed a concern, or could not run. */
export interface Flag extends FlagCandidate {
  id: string;
  at: number;
  status: "confirmed" | "unverified";
  category?: string;
  severity?: "low" | "medium" | "high" | "none";
  reason?: string;
}
