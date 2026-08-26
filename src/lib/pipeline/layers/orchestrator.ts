/**
 * The ride-along arrangement: B and E run beside a reply ElevenLabs has already begun.
 *
 * Nothing here is ever awaited by the dialogue loop. That is the whole safety story — a
 * layer that hangs, throws or times out costs the speaker nothing, because no branch of a
 * turn waits on one. docs/layers.md
 */
import type { EventBus } from "../../events";
import type { Persona } from "../../persona";
import {
  archive,
  FAIL_OPEN,
  looksLikeRecall,
  newState,
  recallTier1,
  recallTier2,
  record,
  validate,
  type LayerState,
  type RecallResult,
} from "./layers";
import type { LayerLlm } from "./llm";

const NOT_FOUND = "Nothing about that was said earlier in this conversation.";

export interface LayerStackDeps {
  bus: EventBus;
  llm: LayerLlm;
  persona: Persona;
  /** Adds context without provoking a turn. No-op before the socket is up. */
  pushContext: (text: string) => void;
  /** False runs B and E one after another — the control the overlap test needs. */
  speculate?: boolean;
}

export class LayerStack {
  private state: LayerState = newState();

  constructor(private deps: LayerStackDeps) {}

  /** What D has recorded so far, for tests and for the recall tool. */
  get transcript(): readonly { role: string; text: string }[] {
    return this.state.transcript;
  }

  get facts(): readonly string[] {
    return this.state.archive.facts;
  }

  /**
   * A user turn: D records it, then B and E read it concurrently.
   *
   * Tier 1 is a string match over facts already in memory, so its context update goes out
   * within a millisecond of the transcript arriving — early enough to plausibly reach the
   * reply being generated. B and tier 2 are hundreds of milliseconds behind that and steer
   * the next turn instead.
   */
  async onUserUtterance(utterance: string): Promise<void> {
    record(this.state, "user", utterance);

    const tier1 = recallTier1(this.state, utterance);
    if (tier1.found) {
      this.report(tier1);
      this.deps.pushContext(`Recalled from earlier in this conversation: ${tier1.answer}`);
    }

    // Fired before we know whether it is needed. B decides afterwards whether to keep it.
    const speculating =
      (this.deps.speculate ?? true) && !tier1.found && looksLikeRecall(utterance);
    const speculative = speculating ? this.search(utterance) : null;

    const verdict =
      (await this.lane("gate", () => validate(this.deps.llm, this.deps.persona, utterance))) ??
      FAIL_OPEN;
    this.deps.bus.emit({
      type: "gate-verdict",
      scope: verdict.scope,
      needsRecall: verdict.needsRecall,
      degraded: verdict.degraded,
      at: performance.now(),
    });

    if (!verdict.needsRecall || tier1.found) {
      // A dropped speculation still has to be consumed, or an unhandled rejection surfaces
      // as an error the conversation never caused.
      await speculative;
      return;
    }

    const hit = await (speculative ?? this.search(verdict.query || utterance));
    this.deps.pushContext(
      hit?.found
        ? `Recalled from earlier in this conversation: ${hit.answer}`
        : NOT_FOUND,
    );
  }

  /**
   * E as a blocking client tool.
   *
   * This is the only arrangement in which recall is on the reply path: the SDK awaits the
   * handler, so the agent genuinely waits. It runs only if the tool is declared on the
   * ElevenLabs agent, which lives in their dashboard and not in this repo — until then the
   * handler is never called and recall reaches the model as a contextual update instead.
   */
  async recall(query: string): Promise<string> {
    const tier1 = recallTier1(this.state, query);
    if (tier1.found) {
      this.report(tier1);
      return tier1.answer;
    }
    const tier2 = await this.search(query);
    return tier2.found ? tier2.answer : NOT_FOUND;
  }

  /** The agent's reply is part of the record; C summarises both halves. */
  onAgentReply(text: string): void {
    record(this.state, "agent", text);
  }

  /** C, on the turn boundary. Runs while the next capture is already open. */
  async onTurnEnd(): Promise<void> {
    const changed = await this.lane("archive", () => archive(this.deps.llm, this.state));
    if (!changed?.changed) return;
    this.deps.bus.emit({
      type: "archive-updated",
      facts: this.state.archive.facts.length,
      at: performance.now(),
    });
    const { summary, facts } = this.state.archive;
    this.deps.pushContext(
      `Earlier in this conversation: ${summary}${facts.length ? `\nFacts: ${facts.join("; ")}` : ""}`,
    );
  }

  close(): void {
    this.deps.llm.close();
  }

  private async search(query: string): Promise<RecallResult> {
    const hit = await this.lane("recall", () => recallTier2(this.deps.llm, this.state, query));
    const result = hit ?? { found: false, answer: "", tier: 2 as const };
    this.report(result);
    return result;
  }

  private report(result: RecallResult): void {
    this.deps.bus.emit({
      type: "recall-result",
      found: result.found,
      tier: result.tier,
      at: performance.now(),
    });
  }

  /**
   * Draws a layer as a lane and swallows its failure.
   *
   * Returning null rather than rethrowing is the point: every caller above has a defined
   * behaviour when a layer produced nothing, and none of them may propagate.
   */
  private async lane<T>(
    stage: "gate" | "recall" | "archive",
    run: () => Promise<T>,
  ): Promise<T | null> {
    const at = performance.now();
    this.deps.bus.emit({ type: "stage-start", stage, at });
    try {
      return await run();
    } catch {
      // Swallowed on purpose: a failed layer is drawn as a short lane, not as a line in
      // the conversation, and never as a rejection the dialogue loop has to handle.
      return null;
    } finally {
      this.deps.bus.emit({ type: "stage-end", stage, at: performance.now(), ttfbMs: 0 });
    }
  }
}
