import { expect, test } from "vitest";
import { EventBus } from "../../events";
import { personaFor } from "../../persona";
import type { PipelineEvent } from "../../types";
import { LayerStack } from "./orchestrator";
import { mockLayerLlm, type LayerCall } from "./llm";
import { looksLikeRecall, prefilter, recallTier1, newState, record } from "./layers";

const persona = personaFor("car-seller");

/** Latencies chosen so a serial arrangement is unambiguously slower than a parallel one. */
const LAT = { validator: 120, searcher: 240, archiver: 300 };

function scriptedLlm(overrides: Partial<Record<string, () => never>> = {}) {
  return mockLayerLlm(({ layer }: LayerCall) => {
    overrides[layer]?.();
    switch (layer) {
      case "validator":
        return {
          totalMs: LAT.validator,
          text: '{"scope":"in_scope","needs_recall":true,"query":"towing"}',
        };
      case "searcher":
        return { totalMs: LAT.searcher, text: '{"found":true,"answer":"a horse box, two tonnes"}' };
      case "archiver":
        return { totalMs: LAT.archiver, text: '{"summary":"talked cars","facts":["budget 60k"]}' };
      default:
        return { totalMs: 10, text: "{}" };
    }
  });
}

function harness(llm = scriptedLlm(), speculate = true) {
  const bus = new EventBus();
  const events: PipelineEvent[] = [];
  bus.on((e) => events.push(e));
  const pushed: string[] = [];
  const stack = new LayerStack({ bus, llm, persona, pushContext: (t) => pushed.push(t), speculate });
  return { stack, events, pushed };
}

/** Milliseconds two lanes were in flight at the same time. 0 means strictly serial. */
function overlapMs(events: PipelineEvent[], a: string, b: string): number {
  const span = (stage: string) => {
    const at = (type: string) =>
      events.find((e) => e.type === type && "stage" in e && e.stage === stage) as
        | { at: number }
        | undefined;
    const start = at("stage-start");
    const end = at("stage-end");
    return start && end ? { start: start.at, end: end.at } : null;
  };
  const x = span(a);
  const y = span(b);
  if (!x || !y) return 0;
  return Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
}

const RECALL = "remind me what I said I'd be towing earlier?";

test("the gate and the search run at the same time", async () => {
  // The whole arrangement exists to remove one round trip. A stack that ran B, then E,
  // then reported the same verdicts would pass every other assertion here.
  const { stack, events } = harness();

  await stack.onUserUtterance(RECALL);

  expect(
    overlapMs(events, "gate", "recall"),
    "the speculative search should cover most of the gate",
  ).toBeGreaterThan(LAT.validator * 0.6);
});

test("without speculation the same two lanes are strictly serial", async () => {
  const { stack, events } = harness(scriptedLlm(), false);

  await stack.onUserUtterance(RECALL);

  expect(overlapMs(events, "gate", "recall")).toBe(0);
});

test("a recalled answer reaches the model as context", async () => {
  const { stack, pushed } = harness();

  await stack.onUserUtterance(RECALL);

  expect(pushed.join(" ")).toContain("horse box");
});

test("a pinned fact answers without a model call at all", async () => {
  const state = newState();
  state.archive.facts = ["the budget is 60 thousand"];
  expect(recallTier1(state, "what did I say my budget was").found).toBe(true);
  expect(recallTier1(state, "what colour was the interior").found).toBe(false);
});

test("no layer failure can throw at the dialogue loop", async () => {
  // In a voice call an empty turn is indistinguishable from the line going dead, so the
  // rule is enforced here rather than negotiated layer by layer: every one of these used
  // to reach the caller as a rejection.
  const modes: Record<string, () => never> = {
    validator: () => {
      throw new Error("B exploded");
    },
    searcher: () => {
      throw new Error("E exploded");
    },
    archiver: () => {
      throw new Error("C exploded");
    },
  };

  for (const [layer, fail] of Object.entries(modes)) {
    const { stack } = harness(scriptedLlm({ [layer]: fail }));
    for (let i = 0; i < 8; i++) stack.onAgentReply(`filler ${i}`);
    await expect(stack.onUserUtterance(RECALL), `${layer} threw`).resolves.toBeUndefined();
    await expect(stack.onTurnEnd(), `${layer} threw at the turn boundary`).resolves.toBeUndefined();
  }
});

test("a gate that never answers still yields a verdict", async () => {
  // Fail open: the verdict produced when B has crashed maps to answering normally, not to
  // silence.
  const slow = mockLayerLlm(({ layer }) =>
    layer === "validator" ? { totalMs: 5000, text: "{}" } : { totalMs: 5, text: "{}" },
  );
  const { stack, events } = harness(slow, false);

  await stack.onUserUtterance("how much can it tow?");

  const verdict = events.find((e) => e.type === "gate-verdict");
  expect(verdict, "a verdict is emitted even when B times out").toBeDefined();
  expect(verdict).toMatchObject({ scope: "unknown", degraded: true });
});

test("unparseable JSON is a fail-open verdict, not a crash", async () => {
  const prose = mockLayerLlm(() => ({ totalMs: 5, text: "Sure! Here you go: not json" }));
  const { stack, events } = harness(prose);

  await stack.onUserUtterance("how much can it tow?");

  expect(events.find((e) => e.type === "gate-verdict")).toMatchObject({ degraded: true });
});

test("the archive only ever grows", async () => {
  const { stack } = harness();
  for (let i = 0; i < 8; i++) stack.onAgentReply(`filler ${i}`);

  await stack.onTurnEnd();
  const first = [...stack.facts];
  await stack.onTurnEnd();

  expect(stack.facts.length).toBeGreaterThanOrEqual(first.length);
});

test("the recall heuristic fires on questions about earlier, and not on fresh ones", () => {
  expect(looksLikeRecall("what did I say my budget was")).toBe(true);
  expect(looksLikeRecall("how much can a Sport tow")).toBe(false);
});

test("the prefilter widens a hit into a window rather than handing over one line", () => {
  const state = newState();
  ["a", "towing a horse box", "c", "d"].forEach((t) => record(state, "user", t));

  const windows = prefilter(state.transcript, "towing");

  expect(windows.length).toBe(1);
  expect(windows[0].length, "the neighbours carry the context").toBeGreaterThan(1);
});
