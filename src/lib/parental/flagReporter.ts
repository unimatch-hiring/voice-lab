import type { EventBus } from "../events";
import type { ParentApi } from "./parentApi";
import type { ContextLine, FlagCandidate } from "./types";

/** How many lines before the message the review sees. Mirrors `MAX_CONTEXT_LINES` on the server. */
const CONTEXT_LINES = 3;

/**
 * Sends every child message for review, with the lines before it and the agent's answer —
 * so it is sent once that answer is in. Reviews are cheap; a keyword filter missed real
 * distress said in plain words. Never touches the conversation.
 */
export function watchForFlags(bus: EventBus, api: Pick<ParentApi, "reviewFlag">): () => void {
  const recent: ContextLine[] = [];
  // A reply arrives either streamed token by token or as one message, never both.
  let reply = "";
  let pending: Omit<FlagCandidate, "agentReply"> | null = null;

  const remember = (line: ContextLine) => {
    recent.push(line);
    if (recent.length > CONTEXT_LINES) recent.shift();
  };

  const flush = () => {
    if (pending) {
      const candidate: FlagCandidate = { ...pending, agentReply: reply.trim() || undefined };
      api.reviewFlag(candidate).catch((err) => console.warn("could not send a message for review", err));
    }
    pending = null;
  };

  const stop = bus.on((e) => {
    if (e.type === "llm-token") reply += e.token;
    if (e.type === "agent-reply") reply = e.text;
    // Listening again: the agent has finished answering.
    if (e.type === "turn-start" && reply.trim()) flush();
    if (e.type !== "stt-result") return;

    flush();
    if (reply.trim()) remember({ role: "assistant", text: reply.trim() });
    reply = "";

    // Silence comes through as "..."; there is nothing to review in it.
    if (/\p{L}/u.test(e.result.text)) pending = { text: e.result.text, context: [...recent] };
    remember({ role: "child", text: e.result.text });
  });

  return () => {
    stop();
    flush();
  };
}
