/** Request-body parsing. Every function returns the parsed value, or null when invalid. */

import {
  ENDED_BY, MAX_END_MESSAGE_LENGTH, MAX_ENTRIES_PER_REQUEST, MAX_ID_LENGTH, MAX_TEXT_LENGTH,
  STAGE_NAMES,
} from "../shared/historyContract.js";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringOfLength = (value, min, max) =>
  typeof value === "string" && value.length >= min && value.length <= max;
// SQLite integer columns are STRICT: a fractional or unsafe value would make the insert throw.
const isIntegerAtLeast = (value, min) => Number.isSafeInteger(value) && value >= min;
const isNonNegativeNumber = (value) => Number.isFinite(value) && value >= 0;

export function parseId(value) {
  return isStringOfLength(value, 1, MAX_ID_LENGTH) ? value : null;
}

export function parseOpenBody(body) {
  if (!isObject(body)) return null;
  const { conversationId, agentId } = body;
  if (!isStringOfLength(conversationId, 1, MAX_ID_LENGTH)) return null;
  if (!isStringOfLength(agentId, 1, MAX_ID_LENGTH)) return null;
  return { conversationId, agentId };
}

function parseLine(entry) {
  const { seq, speaker, text, atMs } = entry;
  if (!isIntegerAtLeast(seq, 1) || !isIntegerAtLeast(atMs, 0)) return null;
  if (speaker !== "user" && speaker !== "agent") return null;
  if (!isStringOfLength(text, 1, MAX_TEXT_LENGTH)) return null;
  return { kind: "line", seq, speaker, text, atMs };
}

function parseStages(stages) {
  if (!isObject(stages)) return null;
  const parsed = {};
  for (const [name, value] of Object.entries(stages)) {
    if (!STAGE_NAMES.includes(name) || !isNonNegativeNumber(value)) return null;
    parsed[name] = value;
  }
  return parsed;
}

function parseMetrics(metrics) {
  if (!isObject(metrics)) return null;
  const stages = parseStages(metrics.stages);
  const { totalMs, llmTokens, ttsChars } = metrics;
  if (!stages || !isNonNegativeNumber(totalMs)) return null;
  if (!isIntegerAtLeast(llmTokens, 0) || !isIntegerAtLeast(ttsChars, 0)) return null;
  return { stages, totalMs, llmTokens, ttsChars };
}

function parseTurn(entry) {
  const { seq, atMs } = entry;
  if (!isIntegerAtLeast(seq, 1) || !isIntegerAtLeast(atMs, 0)) return null;
  const metrics = parseMetrics(entry.metrics);
  return metrics && { kind: "turn", seq, atMs, metrics };
}

function parseEnd(entry) {
  const { endedBy, segment, message } = entry;
  if (!ENDED_BY.includes(endedBy) || !isIntegerAtLeast(segment, 1)) return null;
  if (message === undefined) return { kind: "end", endedBy, segment };
  if (!isStringOfLength(message, 0, MAX_END_MESSAGE_LENGTH)) return null;
  return { kind: "end", endedBy, segment, message };
}

function parseResume(entry) {
  const { segment } = entry;
  return isIntegerAtLeast(segment, 1) ? { kind: "resume", segment } : null;
}

const ENTRY_PARSERS = {
  line: parseLine, turn: parseTurn, end: parseEnd, resume: parseResume,
};

function parseEntry(entry) {
  if (!isObject(entry) || !Object.hasOwn(ENTRY_PARSERS, entry.kind)) return null;
  return ENTRY_PARSERS[entry.kind](entry);
}

export function parseEntries(body) {
  if (!isObject(body) || !Array.isArray(body.entries)) return null;
  const { entries } = body;
  if (entries.length < 1 || entries.length > MAX_ENTRIES_PER_REQUEST) return null;
  const parsed = entries.map(parseEntry);
  return parsed.includes(null) ? null : parsed;
}
