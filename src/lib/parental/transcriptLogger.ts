import type { EventBus } from "../events";
import type { ParentApi } from "./parentApi";

/** Writes every line of the conversation to the server's log, child and agent alike. */
export function logTranscript(bus: EventBus, api: Pick<ParentApi, "appendTranscript">): () => void {
  // A reply arrives either streamed token by token or as one message, never both.
  let reply = "";

  const send = (role: "child" | "assistant", text: string) => {
    if (!text.trim()) return;
    api.appendTranscript({ role, text: text.trim() }).catch((err) => console.warn("transcript log failed", err));
  };
  const flushReply = () => {
    send("assistant", reply);
    reply = "";
  };

  const stop = bus.on((e) => {
    if (e.type === "llm-token") reply += e.token;
    if (e.type === "agent-reply") reply = e.text;
    if (e.type === "turn-start") flushReply();
    if (e.type === "stt-result") {
      flushReply();
      send("child", e.result.text);
    }
  });
  return () => {
    stop();
    flushReply();
  };
}
