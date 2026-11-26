import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../events";
import { watchForFlags } from "./flagReporter";
import type { ParentApi } from "./parentApi";

const childSays = (bus: EventBus, text: string) =>
  bus.emit({ type: "stt-result", result: { text, words: [] } });
const agentSays = (bus: EventBus, ...tokens: string[]) => {
  for (const token of tokens) bus.emit({ type: "llm-token", token, at: 0 });
  bus.emit({ type: "turn-start", at: 0 });
};

function harness() {
  const bus = new EventBus();
  const api = { reviewFlag: vi.fn<ParentApi["reviewFlag"]>(async () => ({ flagged: false })) };
  const stop = watchForFlags(bus, api);
  return { bus, api, stop };
}

describe("flag reporter", () => {
  it("sends every child message, even one with no alarming word in it", () => {
    const { bus, api } = harness();

    childSays(bus, "Мамы второй день нет, я ем хлеб");
    agentSays(bus, "А кто сейчас с тобой?");

    expect(api.reviewFlag).toHaveBeenCalledWith({
      text: "Мамы второй день нет, я ем хлеб",
      context: [],
      agentReply: "А кто сейчас с тобой?",
    });
  });

  it("sends the lines before the message and the agent's answer to it", () => {
    const { bus, api } = harness();

    childSays(bus, "Привет");
    agentSays(bus, "Привет! ", "Как дела?");
    childSays(bus, "Плохо");
    agentSays(bus, "Что случилось?");

    expect(api.reviewFlag).toHaveBeenLastCalledWith({
      text: "Плохо",
      context: [
        { role: "child", text: "Привет" },
        { role: "assistant", text: "Привет! Как дела?" },
      ],
      agentReply: "Что случилось?",
    });
  });

  it("waits for the agent's answer before sending", () => {
    const { bus, api } = harness();

    childSays(bus, "Мне холодно");

    expect(api.reviewFlag).not.toHaveBeenCalled();
  });

  it("keeps only the last three lines of context", () => {
    const { bus, api } = harness();

    for (const line of ["раз", "два", "три", "четыре"]) childSays(bus, line);
    childSays(bus, "пять");
    agentSays(bus, "Шесть!");

    expect(api.reviewFlag.mock.lastCall?.[0].context.map((l) => l.text)).toEqual([
      "два",
      "три",
      "четыре",
    ]);
  });

  it("does not lose the last message when the conversation ends before the answer", () => {
    const { bus, api, stop } = harness();

    childSays(bus, "Мне страшно");
    stop();

    expect(api.reviewFlag).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Мне страшно", agentReply: undefined }),
    );
  });

  it("takes the agent's answer when it arrives as one message", () => {
    const { bus, api } = harness();

    childSays(bus, "Мне холодно");
    bus.emit({ type: "agent-reply", text: "Укройся пледом.", at: 0 });
    bus.emit({ type: "turn-start", at: 0 });

    expect(api.reviewFlag).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Мне холодно", agentReply: "Укройся пледом." }),
    );
  });

  it("never gives one message the answer to another", () => {
    const { bus, api, stop } = harness();

    childSays(bus, "Привет");
    agentSays(bus, "Привет!");
    childSays(bus, "Мне страшно");
    stop();

    expect(api.reviewFlag).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Мне страшно", agentReply: undefined }),
    );
  });

  it("sends each message exactly once", () => {
    const { bus, api, stop } = harness();

    childSays(bus, "раз");
    agentSays(bus, "один");
    bus.emit({ type: "turn-start", at: 0 });
    childSays(bus, "два");
    agentSays(bus, "два");
    stop();

    expect(api.reviewFlag.mock.calls.map(([c]) => c.text)).toEqual(["раз", "два"]);
  });

  it("keeps sending after a review request fails", async () => {
    const { bus, api } = harness();
    api.reviewFlag.mockRejectedValueOnce(new Error("server down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    childSays(bus, "раз");
    agentSays(bus, "один");
    childSays(bus, "два");
    agentSays(bus, "два");
    await Promise.resolve();

    expect(api.reviewFlag).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("does not send silence for review", () => {
    const { bus, api } = harness();

    childSays(bus, "...");
    agentSays(bus, "Ты ещё здесь?");

    expect(api.reviewFlag).not.toHaveBeenCalled();
  });

  it("stops listening once the conversation is over", () => {
    const { bus, api, stop } = harness();

    stop();
    childSays(bus, "Мне страшно");
    agentSays(bus, "…");

    expect(api.reviewFlag).not.toHaveBeenCalled();
  });
});
