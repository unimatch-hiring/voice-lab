import {
  MAX_END_MESSAGE_LENGTH,
  MAX_ENTRIES_PER_REQUEST,
  MAX_LINES_PER_CONVERSATION,
  MAX_TEXT_LENGTH,
} from "../../shared/historyContract.js";
import type { EndedBy } from "../../shared/historyContract.js";
import type { EventBus } from "./events";
import { lineFromEvent } from "./recorder";
import type { PipelineEvent, TurnMetrics } from "./types";

/**
 * Streams one conversation to the local history server while it happens, so a closed tab
 * or a crash loses seconds of transcript rather than all of it.
 *
 * One stream is one page visit: End followed by Start continues the same conversation as a
 * new segment (numbered from 1), so line numbers and times keep counting.
 *
 * Every entry carries a seq (or, for an ending, the segment) and the server drops entries it
 * has already seen, which is what makes re-sending after a lost answer safe.
 */

export type { EndedBy };

export type HistoryEntry =
  | { kind: "line"; seq: number; speaker: "user" | "agent"; text: string; atMs: number }
  | { kind: "turn"; seq: number; atMs: number; metrics: TurnMetrics }
  | { kind: "resume"; segment: number }
  | { kind: "end"; endedBy: EndedBy; segment: number; message?: string };

export interface HistorySummary {
  lengthMs: number;
  endedBy: EndedBy;
  message?: string;
}

/** `refused`: the server answered with a 4xx. `unreachable`: no acknowledgement within the drain window. */
export type NotSavedReason = "refused" | "unreachable";

/** What the visitor is told: `recording` while a segment runs; once it ended, `saving` and then exactly one of `saved` / `notSaved`. */
export type HistoryStatus =
  | { kind: "recording" }
  | { kind: "saving" }
  | { kind: "saved"; summary: HistorySummary }
  | { kind: "notSaved"; reason: NotSavedReason };

export interface HistoryStreamDeps {
  bus: EventBus;
  historyUrl: string;
  userId: string;
  fetch: typeof fetch;
  /** Same clock as the `at` of bus events. */
  now?: () => number;
  onStatus: (status: HistoryStatus) => void;
}

const DRAIN_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** The browser rejects a keepalive request with a larger body whole, and sums the bodies in flight per document. */
export const KEEPALIVE_BODY_LIMIT_BYTES = 64 * 1024;

type Timer = ReturnType<typeof setTimeout>;

/** What the single request slot is doing; `attempt` counts the failures of the batch in flight. */
type Delivery =
  | { name: "idle" }
  | { name: "inFlight"; attempt: number; abort: AbortController; timeout: Timer }
  | { name: "backoff"; timer: Timer };

type InFlight = Extract<Delivery, { name: "inFlight" }>;

/** What survives from one segment to the next; `startedAt` is the first Start's, and the seq counters keep counting across segments. */
interface Conversation {
  conversationId: string;
  agentId: string;
  startedAt: number;
  segment: number;
  lineSeq: number;
  turnSeq: number;
}

interface OpenState extends Conversation {
  name: "open";
  delivery: Delivery;
}

interface DrainingState extends Conversation {
  name: "draining";
  delivery: Delivery;
  drainTimer: Timer;
  endedAt: number;
  endedBy: EndedBy;
  message?: string;
}

type SendingState = OpenState | DrainingState;

interface SavedState extends Conversation {
  name: "saved";
  summary: HistorySummary;
}

/** The server could not be reached; a later Start can still try again. */
interface UnreachableState extends Conversation {
  name: "notSaved";
  reason: "unreachable";
}

/** The server refused the conversation; nothing more is sent for it. */
interface RefusedState {
  name: "notSaved";
  reason: "refused";
}

/** Where a Start after an ending continues the same conversation. */
type ResumableState = DrainingState | SavedState | UnreachableState;

type State =
  | { name: "idle" }
  | OpenState
  | DrainingState
  | SavedState
  | UnreachableState
  | RefusedState
  | { name: "disposed" };

/** The open request goes first and alone; everything after it is entries. */
type QueueItem = { kind: "open" } | HistoryEntry;

function isEntry(item: QueueItem): item is HistoryEntry {
  return item.kind !== "open";
}

function isSending(state: State): state is SendingState {
  return state.name === "open" || state.name === "draining";
}

function conversationOf(state: Conversation): Conversation {
  const { conversationId, agentId, startedAt, segment, lineSeq, turnSeq } = state;
  return { conversationId, agentId, startedAt, segment, lineSeq, turnSeq };
}

/**
 * The longest head of `entries` that fits `budgetBytes` together with `kept`, then `kept` itself,
 * and the size of that body; nothing (0 bytes) when `kept` alone does not fit.
 */
function entriesFittingBudget(
  entries: HistoryEntry[],
  budgetBytes: number,
  kept: HistoryEntry[] = [],
): { fitting: HistoryEntry[]; bodyBytes: number } {
  const encoder = new TextEncoder();
  const sizeOf = (list: HistoryEntry[]) => encoder.encode(JSON.stringify({ entries: list })).length;
  if (kept.length > 0 && sizeOf(kept) > budgetBytes) return { fitting: [], bodyBytes: 0 };

  const head: HistoryEntry[] = [];
  let bodyBytes = kept.length > 0 ? sizeOf(kept) : 0;
  for (const entry of entries.slice(0, MAX_ENTRIES_PER_REQUEST - kept.length)) {
    const size = sizeOf([...head, entry, ...kept]);
    if (size > budgetBytes) break;
    head.push(entry);
    bodyBytes = size;
  }
  return { fitting: [...head, ...kept], bodyBytes };
}

/** One per page visit. */
export class HistoryStream {
  private state: State = { name: "idle" };
  private queue: QueueItem[] = [];
  private unsubscribe: () => void;

  constructor(private deps: HistoryStreamDeps) {
    this.unsubscribe = deps.bus.on((e) => this.onEvent(e));
  }

  addTurn(metrics: TurnMetrics): void {
    if (this.state.name !== "open") return;
    this.enqueue({
      kind: "turn",
      seq: ++this.state.turnSeq,
      atMs: Math.round(this.now() - this.state.startedAt),
      metrics,
    });
  }

  end(endedBy: EndedBy, message?: string): void {
    const state = this.state;
    if (state.name !== "open") return;
    this.queue.push({
      kind: "end",
      endedBy,
      segment: state.segment,
      message: message?.slice(0, MAX_END_MESSAGE_LENGTH),
    });

    this.transition({
      name: "draining",
      ...conversationOf(state),
      delivery: this.withBackoffReset(state.delivery),
      drainTimer: setTimeout(() => this.onDrainTimeout(), DRAIN_TIMEOUT_MS),
      endedAt: this.now(),
      endedBy,
      message,
    });
    this.pump();
  }

  /** Entries still queued go out in one request that survives the page being torn down; returns the bytes of its body. */
  flushOnPageHide(budgetBytes: number = KEEPALIVE_BODY_LIMIT_BYTES): number {
    const state = this.state;
    if (!isSending(state)) return 0;
    // A tab closing mid-segment is how that segment ends; during draining the ending is already queued.
    if (state.name === "open") this.queue.push({ kind: "end", endedBy: "closed", segment: state.segment });
    const head = this.queue[0];
    // Entries are refused until the first open lands. A later segment's open repeats one the server
    // has already had, so it does not hold the flush back.
    if (!head || (head.kind === "open" && state.segment === 1)) return 0;

    // The ending goes even when older entries are left behind: the server applies it in any order.
    const entries = this.queue.filter(isEntry);
    const last = entries[entries.length - 1];
    const ending = last?.kind === "end" ? [last] : [];
    const { fitting, bodyBytes } = entriesFittingBudget(entries.slice(0, entries.length - ending.length), budgetBytes, ending);
    if (fitting.length === 0) return 0;
    this.post(this.entriesPath(state), { entries: fitting }, { keepalive: true }).catch(() => {});
    return bodyBytes;
  }

  dispose(): void {
    if (this.state.name === "disposed") return;
    this.transition({ name: "disposed" });
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }

  private onEvent(e: PipelineEvent): void {
    if (e.type === "conversation-start") {
      this.onConversationStart(e);
      return;
    }

    const state = this.state;
    if (state.name !== "open") return;
    // The server refuses a line past its cap and a refusal ends the stream; turns and the ending still go.
    if (state.lineSeq >= MAX_LINES_PER_CONVERSATION) return;
    const line = lineFromEvent(e, Math.round(this.now() - state.startedAt));
    if (line) {
      this.enqueue({ kind: "line", seq: ++state.lineSeq, ...line, text: line.text.slice(0, MAX_TEXT_LENGTH) });
    }
  }

  private onConversationStart(e: Extract<PipelineEvent, { type: "conversation-start" }>): void {
    const state = this.state;
    if (state.name === "idle") {
      this.transition({
        name: "open",
        conversationId: e.conversationId,
        agentId: e.agentId,
        startedAt: e.at,
        segment: 1,
        lineSeq: 0,
        turnSeq: 0,
        delivery: { name: "idle" },
      });
      this.queue.push({ kind: "open" });
      this.pump();
    } else if (state.name === "draining" || state.name === "saved" || (state.name === "notSaved" && state.reason === "unreachable")) {
      this.resume(state);
    }
  }

  /** Continues the same conversation, whatever the new Start's own id is. */
  private resume(state: ResumableState): void {
    const segment = state.segment + 1;
    const delivery: Delivery = state.name === "draining" ? this.withBackoffReset(state.delivery) : { name: "idle" };
    this.transition({ name: "open", ...conversationOf(state), segment, delivery });
    // The open may never have got through; the server answers 200 for an id it already has.
    this.queue.push({ kind: "open" }, { kind: "resume", segment });
    this.pump();
  }

  /** Refused or timed out: what was queued is dropped. A refusal is final; an unreachable server can be tried again by the next Start. */
  private giveUp(state: SendingState, reason: NotSavedReason): void {
    this.queue = [];
    this.transition(
      reason === "refused"
        ? { name: "notSaved", reason: "refused" }
        : { name: "notSaved", reason: "unreachable", ...conversationOf(state) },
    );
  }

  private enqueue(entry: HistoryEntry): void {
    this.queue.push(entry);
    this.pump();
  }

  /** The only place the state changes: leaving a sending state stops what it had running, and the visitor-facing statuses are reported here. */
  private transition(next: State): void {
    const previous = this.state;
    this.state = next;

    if (isSending(previous)) {
      // An ending, and a Start during its draining, take over the request slot as it is.
      if (!isSending(next)) this.cancelDelivery(previous.delivery);
      if (previous.name === "draining") clearTimeout(previous.drainTimer);
    }

    // The stream stays subscribed after `saved` and an unreachable `notSaved`: a later Start resumes it.
    switch (next.name) {
      case "open":
        this.deps.onStatus({ kind: "recording" });
        break;
      case "draining":
        this.deps.onStatus({ kind: "saving" });
        break;
      case "saved":
        this.deps.onStatus({ kind: "saved", summary: next.summary });
        break;
      case "notSaved":
        if (next.reason === "refused") this.unsubscribe();
        this.deps.onStatus({ kind: "notSaved", reason: next.reason });
        break;
      case "disposed":
        this.unsubscribe();
        break;
    }
  }

  private cancelDelivery(delivery: Delivery): void {
    if (delivery.name === "inFlight") {
      clearTimeout(delivery.timeout);
      delivery.abort.abort();
    } else if (delivery.name === "backoff") {
      clearTimeout(delivery.timer);
    }
  }

  /** The wait can be up to 30 s, the ending has 15: send now and start the backoff over. */
  private withBackoffReset(delivery: Delivery): Delivery {
    if (delivery.name === "backoff") {
      clearTimeout(delivery.timer);
      return { name: "idle" };
    }
    if (delivery.name === "inFlight") {
      // In place: send() recognises its own request by the object's identity.
      delivery.attempt = 0;
    }
    return delivery;
  }

  private onDrainTimeout(): void {
    if (this.state.name === "draining") this.giveUp(this.state, "unreachable");
  }

  private summary(state: DrainingState): HistorySummary {
    return {
      lengthMs: Math.round(state.endedAt - state.startedAt),
      endedBy: state.endedBy,
      message: state.message,
    };
  }

  /** Sends the head of the queue if the request slot is free; settles `draining` once nothing is left. */
  private pump(): void {
    const state = this.state;
    if (!isSending(state) || state.delivery.name !== "idle") return;

    if (this.queue.length === 0) {
      if (state.name === "draining") this.transition({ name: "saved", ...conversationOf(state), summary: this.summary(state) });
      return;
    }

    this.dispatch(state, this.nextBatchSize(), 0);
  }

  /** An open request goes alone, and entries never ride past one: a resume queues its open behind entries still waiting. */
  private nextBatchSize(): number {
    if (this.queue[0].kind === "open") return 1;
    const nextOpenAt = this.queue.findIndex((item) => item.kind === "open");
    const entriesBeforeIt = nextOpenAt === -1 ? this.queue.length : nextOpenAt;
    return Math.min(entriesBeforeIt, MAX_ENTRIES_PER_REQUEST);
  }

  /** Sends the first `batchSize` queued items; a retry passes the same size so the same items go again. */
  private dispatch(state: SendingState, batchSize: number, attempt: number): void {
    const abort = new AbortController();
    const sending: InFlight = {
      name: "inFlight",
      attempt,
      abort,
      timeout: setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS),
    };
    state.delivery = sending;
    void this.send(state, sending, batchSize);
  }

  private async send(state: SendingState, sending: InFlight, batchSize: number): Promise<void> {
    const items = this.queue.slice(0, batchSize);
    let status: number | null = null;
    try {
      const response = await this.request(state, items, sending.abort.signal);
      status = response.ok ? 200 : response.status;
    } catch {
      // Network error or the request timed out: handled below like a 5xx.
    }
    clearTimeout(sending.timeout);
    // The stream was disposed or finished while the request was out; its answer no longer matters.
    if (!isSending(this.state) || this.state.delivery !== sending) return;

    if (status === 200) {
      this.queue.splice(0, batchSize);
      this.state.delivery = { name: "idle" };
      this.pump();
    } else if (status !== null && status >= 400 && status < 500) {
      this.giveUp(this.state, "refused");
    } else {
      this.scheduleRetry(this.state, batchSize, sending.attempt);
    }
  }

  private scheduleRetry(state: SendingState, batchSize: number, failedAttempts: number): void {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failedAttempts);
    const attempt = failedAttempts + 1;
    const timer = setTimeout(() => this.dispatch(state, batchSize, attempt), delay);
    state.delivery = { name: "backoff", timer };
  }

  private request(state: SendingState, items: QueueItem[], signal: AbortSignal): Promise<Response> {
    if (items[0].kind === "open") {
      return this.post("/conversations", { conversationId: state.conversationId, agentId: state.agentId }, { signal });
    }
    return this.post(this.entriesPath(state), { entries: items.filter(isEntry) }, { signal });
  }

  private entriesPath(state: SendingState): string {
    return `/conversations/${encodeURIComponent(state.conversationId)}/entries`;
  }

  private post(path: string, body: unknown, options: { keepalive?: boolean; signal?: AbortSignal } = {}): Promise<Response> {
    return this.deps.fetch(`${this.deps.historyUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-history-user": this.deps.userId },
      body: JSON.stringify(body),
      ...options,
    });
  }
}
