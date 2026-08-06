import { expect, test } from "vitest";
import { EventBus } from "./events";
import type { PipelineEvent } from "./types";

test("delivers events to subscribers", () => {
  const bus = new EventBus();
  const seen: PipelineEvent[] = [];
  bus.on((e) => seen.push(e));

  bus.emit({ type: "turn-start", at: 0 });

  expect(seen).toHaveLength(1);
  expect(seen[0].type).toBe("turn-start");
});

test("unsubscribe stops delivery", () => {
  const bus = new EventBus();
  const seen: PipelineEvent[] = [];
  const off = bus.on((e) => seen.push(e));

  bus.emit({ type: "turn-start", at: 0 });
  off();
  bus.emit({ type: "turn-end", at: 1, metrics: { stages: {}, llmTokens: 0, ttsChars: 0 } });

  expect(seen).toHaveLength(1);
});

test("one throwing subscriber does not block the others", () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.on(() => { throw new Error("boom"); });
  bus.on((e) => seen.push(e.type));

  bus.emit({ type: "turn-start", at: 0 });

  expect(seen).toEqual(["turn-start"]);
});
