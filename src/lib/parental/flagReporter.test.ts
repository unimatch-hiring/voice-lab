import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../events";
import { watchForFlags } from "./flagReporter";
import type { ParentApi } from "./parentApi";

const childSays = (bus: EventBus, text: string) =>
  bus.emit({ type: "stt-result", result: { text, words: [] } });

function harness(extra: string[] = []) {
  const bus = new EventBus();
  const api = { reviewFlag: vi.fn<ParentApi["reviewFlag"]>(async () => ({ flagged: true })) };
  const stop = watchForFlags(bus, api, extra);
  return { bus, api, stop };
}

describe("flag reporter", () => {
  it("sends the full message with the lines said before it", () => {
    const { bus, api } = harness();

    childSays(bus, "Привет");
    bus.emit({ type: "llm-token", token: "Привет! ", at: 0 });
    bus.emit({ type: "llm-token", token: "Как дела?", at: 0 });
    childSays(bus, "Плохо, папа меня бьёт каждый вечер");

    expect(api.reviewFlag).toHaveBeenCalledWith({
      text: "Плохо, папа меня бьёт каждый вечер",
      matched: ["бьет"],
      context: [
        { role: "child", text: "Привет" },
        { role: "assistant", text: "Привет! Как дела?" },
      ],
    });
  });

  it("keeps only the last three lines of context", () => {
    const { bus, api } = harness();

    for (const line of ["раз", "два", "три", "четыре"]) childSays(bus, line);
    childSays(bus, "не хочу жить");

    expect(api.reviewFlag.mock.calls[0][0].context.map((l) => l.text)).toEqual([
      "два",
      "три",
      "четыре",
    ]);
  });

  it("uses the parent's words too", () => {
    const { bus, api } = harness(["тайна"]);

    childSays(bus, "У нас с дядей тайна");

    expect(api.reviewFlag).toHaveBeenCalledOnce();
  });

  it("sends nothing for an ordinary message", () => {
    const { bus, api } = harness();

    childSays(bus, "Расскажи про космос");

    expect(api.reviewFlag).not.toHaveBeenCalled();
  });

  it("stops listening once the conversation is over", () => {
    const { bus, api, stop } = harness();

    stop();
    childSays(bus, "не хочу жить");

    expect(api.reviewFlag).not.toHaveBeenCalled();
  });
});
