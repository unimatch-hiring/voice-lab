import type { StageName } from "../src/lib/types";

export const MAX_ID_LENGTH: number;
export const MAX_ENTRIES_PER_REQUEST: number;
export const MAX_TEXT_LENGTH: number;
export const MAX_END_MESSAGE_LENGTH: number;
export const MAX_LINES_PER_CONVERSATION: number;
export const USER_ID_V4: RegExp;
export const STAGE_NAMES: readonly StageName[];

export type EndedBy = "user" | "agent" | "error" | "closed";
export const ENDED_BY: readonly EndedBy[];
