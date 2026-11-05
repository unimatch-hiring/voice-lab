import { useEffect, useRef } from "react";
import { parseClaims } from "../lib/claims";
import type { EventBus } from "../lib/events";
import { maskProfanity } from "../lib/profanity";

/**
 * Model text only ever lands in text nodes, so a reply cannot inject markup. Parsed before
 * masking: asterisks read as punctuation, so a hidden word would vanish from the check.
 */
function showClaims(body: HTMLElement, text: string): void {
  body.replaceChildren(
    ...parseClaims(text).map((segment) => {
      const shown = maskProfanity(segment.text);
      if (segment.kind === "plain") return document.createTextNode(shown);
      const claim = document.createElement("span");
      claim.dataset.claim = segment.kind;
      if (segment.kind === "fact") claim.dataset.source = segment.source;
      claim.textContent = shown;
      return claim;
    }),
  );
}

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
  // Masking the accumulated text, not each token: a swear word can span two tokens.
  const openReplyText = useRef("");

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
          openReplyText.current = "";
          break;
        case "stt-result":
          if (e.result.text.trim()) addRow("you", maskProfanity(e.result.text));
          break;
        case "agent-reply":
          // Replaces the streamed line if there is one, so the reply is not shown twice.
          if (e.text.trim()) {
            showClaims(openReply.current ?? addRow("agent", ""), e.text);
            list.scrollTop = list.scrollHeight;
          }
          openReply.current = null;
          openReplyText.current = "";
          break;
        case "llm-token": {
          if (!openReply.current) openReply.current = addRow("agent", "");
          openReplyText.current += e.token;
          openReply.current.textContent = maskProfanity(openReplyText.current);
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
      <ul className="transcript-legend">
        <li className="legend-you">вы</li>
        <li className="legend-fact">факт</li>
        <li className="legend-assumption">предположение</li>
        <li className="legend-unverified">не подтверждено</li>
      </ul>
      <ol className="transcript-lines" ref={listRef} aria-live="polite" />
      <p className="transcript-empty">Nothing said yet.</p>
    </div>
  );
}
