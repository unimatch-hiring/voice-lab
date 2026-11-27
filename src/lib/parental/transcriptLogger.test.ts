import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../events";
import type { ParentApi } from "./parentApi";
import { logTranscript } from "./transcriptLogger";

describe("conversation log", () => {
  it("writes the child's lines and the agent's whole replies, in order", () => {
    const bus = new EventBus();
    const api = { appendTranscript: vi.fn<ParentApi["appendTranscript"]>(async () => ({})) };
    logTranscript(bus, api);

    bus.emit({ type: "stt-result", result: { text: "Мне холодно", words: [] } });
    bus.emit({ type: "llm-token", token: "Укройся ", at: 0 });
    bus.emit({ type: "llm-token", token: "пледом.", at: 0 });
    bus.emit({ type: "turn-start", at: 0 });

    expect(api.appendTranscript.mock.calls.map(([l]) => [l.role, l.text])).toEqual([
      ["child", "Мне холодно"],
      ["assistant", "Укройся пледом."],
    ]);
  });
});
