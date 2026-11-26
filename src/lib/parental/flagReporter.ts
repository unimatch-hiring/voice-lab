import type { EventBus } from "../events";
import type { ParentApi } from "./parentApi";
import { findTriggers } from "./triggers";
import type { ContextLine } from "./types";

/** How many lines before the message the review sees. Mirrors `MAX_CONTEXT_LINES` on the server. */
const CONTEXT_LINES = 3;

/**
 * Sends every child message that hits an alarm phrase for review, with the lines before it.
 * Never touches the conversation: the agent answers as usual whatever happens here.
 */
export function watchForFlags(
  bus: EventBus,
  api: Pick<ParentApi, "reviewFlag">,
  extraWords: string[],
): () => void {
  const recent: ContextLine[] = [];
  // A reply arrives either streamed token by token or as one message, never both.
  let reply = "";

  const remember = (line: ContextLine) => {
    recent.push(line);
    if (recent.length > CONTEXT_LINES) recent.shift();
  };

  return bus.on((e) => {
    if (e.type === "llm-token") reply += e.token;
    if (e.type === "agent-reply") reply = e.text;
    if (e.type !== "stt-result") return;

    if (reply.trim()) remember({ role: "assistant", text: reply.trim() });
    reply = "";

    const text = e.result.text;
    const matched = findTriggers(text, extraWords);
    if (matched.length > 0) {
      api
        .reviewFlag({ text, matched, context: [...recent] })
        .catch((err) => console.warn("could not send a flag for review", err));
    }
    remember({ role: "child", text });
  });
}
