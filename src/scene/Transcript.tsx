import { useEffect, useRef } from "react";
import type { EventBus } from "../lib/events";

/**
 * The conversation as it happens: what the recogniser heard, and the reply
 * assembling token by token while it is still being spoken.
 *
 * Written straight to the DOM rather than through state, per the repo rule: LLM
 * tokens arrive dozens of times a second and a setState per token would turn the
 * stream into a render storm — the exact failure the scene is meant to avoid.
 */
export function Transcript({ bus }: { bus: EventBus }) {
  const listRef = useRef<HTMLOListElement>(null);
  // The assistant line currently being filled in, so tokens append to it instead
  // of creating a row each.
  const openReply = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const addRow = (who: "you" | "agent", text: string): HTMLElement => {
      const row = document.createElement("li");
      row.className = "line";
      row.dataset.who = who;

      const label = document.createElement("span");
      label.className = "line-who";
      label.textContent = who;

      const body = document.createElement("span");
      body.className = "line-text";
      body.textContent = text;

      row.append(label, body);
      list.append(row);
      // Keep the newest line in view; the box scrolls rather than growing, so the
      // panel height never jumps as the conversation gets longer.
      list.scrollTop = list.scrollHeight;
      return body;
    };

    return bus.on((e) => {
      switch (e.type) {
        case "turn-start":
          openReply.current = null;
          break;
        case "stt-result":
          if (e.result.text.trim()) addRow("you", e.result.text);
          break;
        case "llm-token": {
          if (!openReply.current) openReply.current = addRow("agent", "");
          openReply.current.textContent += e.token;
          list.scrollTop = list.scrollHeight;
          break;
        }
        case "stage-error":
          addRow("agent", `${e.stage} failed: ${e.message}`).parentElement?.setAttribute(
            "data-failed",
            "true",
          );
          break;
      }
    });
  }, [bus]);

  return (
    <div className="transcript">
      <div className="transcript-head">conversation</div>
      <ol className="transcript-lines" ref={listRef} aria-live="polite" />
      <p className="transcript-empty">Nothing said yet.</p>
    </div>
  );
}
