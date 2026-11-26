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

  it("sends the child's message when the agent answers with its alarm phrase", () => {
    const { bus, api } = harness();

    childSays(bus, "Мамы второй день нет дома, я голодный, сижу один");
    bus.emit({ type: "llm-token", token: "Если тебе страшно, давай ", at: 0 });
    bus.emit({ type: "llm-token", token: "поговорим об этом. Ты сейчас один?", at: 0 });

    expect(api.reviewFlag).toHaveBeenCalledOnce();
    expect(api.reviewFlag).toHaveBeenCalledWith({
      text: "Мамы второй день нет дома, я голодный, сижу один",
      matched: ["agent: alarm phrase"],
      context: [],
    });
  });

  it("reviews a message once when both a stem and the agent flag it", () => {
    const { bus, api } = harness();

    childSays(bus, "Мне страшно");
    bus.emit({ type: "agent-reply", text: "Если тебе страшно — давай поговорим об этом!", at: 0 });

    expect(api.reviewFlag).toHaveBeenCalledOnce();
  });

  it("ignores an ordinary reply", () => {
    const { bus, api } = harness();

    childSays(bus, "Расскажи про космос");
    bus.emit({ type: "agent-reply", text: "Космос огромный! Давай поговорим об этом.", at: 0 });

    expect(api.reviewFlag).not.toHaveBeenCalled();
  });

  it("stops listening once the conversation is over", () => {
    const { bus, api, stop } = harness();

    stop();
    childSays(bus, "не хочу жить");

    expect(api.reviewFlag).not.toHaveBeenCalled();
  });
});
