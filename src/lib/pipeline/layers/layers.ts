/**
 * The side layers.
 *
 * A is the dialogue loop — `AgentSession`, the caller. F is ElevenLabs' own generation,
 * steered by the persona override applied at handshake. What is here is everything in
 * between: B validator, C archiver, D transcriber, E searcher.
 *
 * None of them can pre-empt a reply, so all of them are written to fail open. docs/layers.md
 */
import type { Persona } from "../../persona";
import { archiverPrompt, searcherPrompt, validatorPrompt } from "../../persona";
import type { Scope } from "../../types";
import { parseJson, withDeadline, type LayerLlm } from "./llm";

export const BUDGET = { validate: 200, recallTier2: 600, archive: 4000 };

export interface Line {
  seq: number;
  role: "user" | "agent";
  text: string;
}

export interface LayerState {
  /** D — append only, verbatim, ordered. */
  transcript: Line[];
  /** C — lossy, rebuildable, derived from the transcript and never the reverse. */
  archive: { summary: string; facts: string[] };
  /** Turns kept verbatim before C is asked to compress. */
  window: number;
}

export interface Verdict {
  scope: Scope;
  needsRecall: boolean;
  query: string;
  degraded: boolean;
}

export interface RecallResult {
  found: boolean;
  answer: string;
  tier: 1 | 2;
}

export function newState(): LayerState {
  return { transcript: [], archive: { summary: "", facts: [] }, window: 6 };
}

// ---------------------------------------------------------------- D · transcriber

/** No model call, so it never appears in a latency budget. */
export function record(state: LayerState, role: "user" | "agent", text: string): Line {
  const line = { seq: state.transcript.length, role, text };
  state.transcript.push(line);
  return line;
}

// ---------------------------------------------------------------- B · validator

/**
 * Fail open, always.
 *
 * B being wrong about scope is survivable. B making the agent go quiet is not — and in a
 * voice call an empty turn is indistinguishable from the line going dead.
 */
export const FAIL_OPEN: Verdict = { scope: "unknown", needsRecall: false, query: "", degraded: true };

interface RawVerdict {
  scope?: Scope;
  needs_recall?: boolean;
  query?: string;
}

export async function validate(
  llm: LayerLlm,
  persona: Persona,
  utterance: string,
  budgetMs = BUDGET.validate,
): Promise<Verdict> {
  const call = llm
    .call({ layer: "validator", systemPrompt: validatorPrompt(persona), userText: utterance })
    .then((r) => parseJson<RawVerdict>(r.text));

  const outcome = await withDeadline(call, budgetMs, "B");
  if (!outcome.ok || !outcome.value?.scope) return FAIL_OPEN;

  const v = outcome.value;
  return {
    scope: v.scope as Scope,
    needsRecall: Boolean(v.needs_recall),
    query: typeof v.query === "string" ? v.query : "",
    degraded: false,
  };
}

// ---------------------------------------------------------------- E · searcher

/**
 * Tier 1 costs nothing: the archive is small enough to already be in the prompt, so a hit
 * is a string match rather than a round trip.
 */
export function recallTier1(state: LayerState, query: string): RecallResult {
  if (!query) return { found: false, answer: "", tier: 1 };
  const needles = tokenize(query);
  const hits = state.archive.facts.filter((f) => overlapScore(tokenize(f), needles) > 0);
  if (hits.length === 0 && state.archive.summary) {
    if (overlapScore(tokenize(state.archive.summary), needles) >= 2) {
      return { found: true, answer: state.archive.summary, tier: 1 };
    }
  }
  return hits.length
    ? { found: true, answer: hits.join(" "), tier: 1 }
    : { found: false, answer: "", tier: 1 };
}

/**
 * Tier 2: narrow the verbatim log lexically first, then let one model call read only the
 * windows that survived.
 *
 * This is what replaces a vector store, and it is why the whole feature adds no runtime
 * dependency.
 */
export async function recallTier2(
  llm: LayerLlm,
  state: LayerState,
  query: string,
  budgetMs = BUDGET.recallTier2,
): Promise<RecallResult> {
  const windows = prefilter(state.transcript, query);
  if (windows.length === 0) return { found: false, answer: "", tier: 2 };

  const excerpts = windows
    .map((w) => w.map((l) => `${l.role}: ${l.text}`).join("\n"))
    .join("\n---\n");

  const call = llm
    .call({
      layer: "searcher",
      systemPrompt: searcherPrompt(),
      userText: `Question: ${query}\n\nExcerpts:\n${excerpts}`,
    })
    .then((r) => parseJson<{ found?: boolean; answer?: string }>(r.text));

  const outcome = await withDeadline(call, budgetMs, "E2");
  if (!outcome.ok || !outcome.value) return { found: false, answer: "", tier: 2 };

  const found = Boolean(outcome.value.found);
  return { found, answer: found ? String(outcome.value.answer ?? "") : "", tier: 2 };
}

/**
 * Free heuristic deciding whether a speculative tier-2 search is worth firing.
 *
 * Speculating on every turn spends a model call per utterance to save latency on the few
 * that need it. A false positive only wastes tokens; B stays authoritative afterwards.
 * It over-fires on markers that are also nouns — "my budget" matches statements as well
 * as questions.
 */
const RECALL_MARKERS = [
  "earlier", "before", "you said", "i said", "i told", "remember", "we discussed",
  "we talked", "mentioned", "last time", "my budget", "what was", "what did", "again",
  "recall", "just now",
];

export function looksLikeRecall(utterance: string): boolean {
  const s = String(utterance).toLowerCase();
  return RECALL_MARKERS.some((m) => s.includes(m));
}

// ---------------------------------------------------------------- C · archiver

/** Off the reply path by construction: the caller starts it and does not await it. */
export async function archive(
  llm: LayerLlm,
  state: LayerState,
  budgetMs = BUDGET.archive,
): Promise<{ changed: boolean }> {
  if (state.transcript.length <= state.window) return { changed: false };

  const older = state.transcript.slice(0, -state.window);
  const body = older.map((l) => `${l.role}: ${l.text}`).join("\n");

  const call = llm
    .call({ layer: "archiver", systemPrompt: archiverPrompt(), userText: body })
    .then((r) => parseJson<{ summary?: string; facts?: string[] }>(r.text));

  const outcome = await withDeadline(call, budgetMs, "C");
  // A failed archiver keeps the previous one. Memory gets shorter, never wrong.
  if (!outcome.ok || !outcome.value) return { changed: false };

  state.archive = {
    summary: String(outcome.value.summary ?? state.archive.summary),
    facts: Array.isArray(outcome.value.facts)
      ? [...new Set([...state.archive.facts, ...outcome.value.facts.map(String)])]
      : state.archive.facts,
  };
  return { changed: true };
}

// ---------------------------------------------------------------- lexical helpers

const STOP = new Set([
  "the", "a", "an", "is", "was", "are", "were", "i", "you", "my", "your", "what", "did",
  "do", "does", "it", "to", "of", "and", "or", "for", "in", "on", "that", "this", "me",
  "we", "he", "she", "they", "at", "be", "have", "has", "with", "about", "say", "said",
]);

export function tokenize(s: string): string[] {
  return String(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function overlapScore(a: string[], b: string[]): number {
  const set = new Set(b);
  return a.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
}

/** Scores each transcript line lexically, keeps the best few, and widens them into windows. */
export function prefilter(
  transcript: Line[],
  query: string,
  { keep = 3, radius = 1 } = {},
): Line[][] {
  const needles = tokenize(query);
  if (needles.length === 0) return [];

  const scored = transcript
    .map((line, i) => ({ i, score: overlapScore(tokenize(line.text), needles) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, keep);

  const merged: { lo: number; hi: number }[] = [];
  for (const { i } of scored.sort((a, b) => a.i - b.i)) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(transcript.length - 1, i + radius);
    const last = merged[merged.length - 1];
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
    else merged.push({ lo, hi });
  }
  return merged.map(({ lo, hi }) => transcript.slice(lo, hi + 1));
}
