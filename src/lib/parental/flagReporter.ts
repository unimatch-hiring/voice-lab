import type { EventBus } from "../events";
import type { ParentApi } from "./parentApi";
import { AGENT_ALARM_MATCH, findTriggers, hasAgentAlarm } from "./triggers";
import type { ContextLine } from "./types";

/** How many lines before the message the review sees. Mirrors `MAX_CONTEXT_LINES` on the server. */
const CONTEXT_LINES = 3;

/**
 * Sends a child message for review when it hits an alarm stem, or when the agent answers
 * it with its alarm phrase — whichever comes first, once per message.
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
  let last: { text: string; context: ContextLine[]; reported: boolean } | null = null;

  const remember = (line: ContextLine) => {
    recent.push(line);
    if (recent.length > CONTEXT_LINES) recent.shift();
  };

  const report = (matched: string[]) => {
    if (!last || last.reported) return;
    last.reported = true;
    api
      .reviewFlag({ text: last.text, matched, context: last.context })
      .catch((err) => console.warn("could not send a flag for review", err));
  };

  return bus.on((e) => {
    if (e.type === "llm-token" || e.type === "agent-reply") {
      reply = e.type === "llm-token" ? reply + e.token : e.text;
      if (hasAgentAlarm(reply)) report([AGENT_ALARM_MATCH]);
      return;
    }
    if (e.type !== "stt-result") return;

    if (reply.trim()) remember({ role: "assistant", text: reply.trim() });
    reply = "";

    const text = e.result.text;
    last = { text, context: [...recent], reported: false };
    const matched = findTriggers(text, extraWords);
    if (matched.length > 0) report(matched);
    remember({ role: "child", text });
  });
}
