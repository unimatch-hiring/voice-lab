/**
 * What the page and the history server must agree on. Plain JavaScript so Node runs it as
 * it is; the page reads it through historyContract.d.ts. Change a limit here and both sides
 * move together — a copy on either side is how the page came to send what the server refuses.
 */

/** Longest conversation id and agent id the server takes. */
export const MAX_ID_LENGTH = 200;
/** Entries in one delivery. */
export const MAX_ENTRIES_PER_REQUEST = 50;
/** Longest line; the page clips to it rather than lose the delivery. */
export const MAX_TEXT_LENGTH = 4000;
/** Longest error message of an ending; the page clips to it too. */
export const MAX_END_MESSAGE_LENGTH = 500;
/** Lines one conversation may hold, so one client cannot grow the file without bound. */
export const MAX_LINES_PER_CONVERSATION = 2000;

/** The only user id shape the server accepts. */
export const USER_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The pipeline's stages (STAGE_ORDER in src/lib/types.ts); a test fails when the two differ. */
export const STAGE_NAMES = Object.freeze(["capture", "vad", "stt", "llm", "tts", "playback"]);

/**
 * Who or what ended a conversation: the user pressed End, the agent hung up, the session
 * failed, or the user left the page (sent from pagehide). Page and server both read this list.
 */
export const ENDED_BY = Object.freeze(["user", "agent", "error", "closed"]);
