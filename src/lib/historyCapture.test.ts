import { expect, test, vi } from "vitest";
import { createHistoryCapture } from "./historyCapture";

test("[TC-024] the first utterance carries the earlier silent conversation’s active duration", () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const enqueue = vi.fn();
  const capture = createHistoryCapture("dialogue", enqueue);
  try {
    const silent = capture.openSession();
    silent.connected();
    now = 20_000;
    silent.finish("user");
    expect(enqueue).not.toHaveBeenCalled();

    now += 60_000;
    const next = capture.openSession();
    next.connected();
    next.record({ type: "agent-reply", text: "Can you hear me?", at: now });

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [
        expect.objectContaining({ messages: [], end: { reason: "user", durationMs: 20_000 } }),
        expect.objectContaining({ messages: [expect.objectContaining({ text: "Can you hear me?" })] }),
      ],
    }));
  } finally {
    clock.mockRestore();
  }
});
