import { useEffect, useRef } from "react";
import type { EventBus } from "../lib/events";
import { SHOP_FACTS } from "../lib/persona";
import { annotate } from "./annotate";

/**
 * The conversation as it happens: what the recogniser heard, and the reply
 * assembling token by token while it is still being spoken.
 *
 * Written straight to the DOM rather than through state, per the repo rule: LLM
 * tokens arrive dozens of times a second and a setState per token would turn the
 * stream into a render storm — the exact failure the scene is meant to avoid.
 *
 * Agent lines are marked against what the tools returned: data from a tool as fact,
 * numbers no tool gave and hedged wording as assumption.
 */
export function Transcript({ bus }: { bus: EventBus }) {
  const listRef = useRef<HTMLOListElement>(null);
  // The assistant line currently being filled in, so tokens append to it instead
  // of creating a row each.
  const openReply = useRef<HTMLElement | null>(null);
  const openText = useRef("");
  // The prompt states the shop facts outright, so they are known before any tool runs.
  const facts = useRef(new Set<string>(SHOP_FACTS));

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

    const paint = (body: HTMLElement, text: string) => {
      body.replaceChildren(
        ...annotate(text, facts.current).map(({ text, mark }) => {
          if (!mark) return document.createTextNode(text);
          const span = document.createElement("span");
          span.className = `mark-${mark}`;
          span.textContent = text;
          return span;
        }),
      );
    };

    return bus.on((e) => {
      switch (e.type) {
        case "turn-start":
          openReply.current = null;
          break;
        case "stt-result":
          if (e.result.text.trim()) addRow("you", e.result.text);
          break;
        case "agent-reply":
          // Whole-message providers: replace the streamed line if there is one, so the
          // reply is not shown twice.
          paint(openReply.current ?? addRow("agent", ""), e.text);
          openReply.current = null;
          break;
        case "llm-token": {
          if (!openReply.current) {
            openReply.current = addRow("agent", "");
            openText.current = "";
          }
          openText.current += e.token;
          // Re-marked whole each time: a price split across tokens ("2" + " 500") only
          // reads as one number once both halves are in.
          paint(openReply.current, openText.current);
          list.scrollTop = list.scrollHeight;
          break;
        }
        case "tool-result":
          for (const f of e.facts) facts.current.add(f);
          break;
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
      <div className="transcript-head">
        conversation
        <span className="transcript-legend">
          <span className="mark-fact">fact — from tools</span>
          <span className="mark-assumption">assumption</span>
        </span>
        <button type="button" className="transcript-download" onClick={() => download(listRef.current)}>
          download
        </button>
      </div>
      <ol className="transcript-lines" ref={listRef} aria-live="polite" />
      <p className="transcript-empty">Nothing said yet.</p>
    </div>
  );
}

/** The lines on screen as a text file: the DOM is the only place the whole conversation is kept. */
function download(list: HTMLOListElement | null) {
  if (!list) return;
  const lines = [...list.querySelectorAll(".line")].map(
    (row) => `${row.querySelector(".line-who")?.textContent}: ${row.querySelector(".line-text")?.textContent}`,
  );
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `conversation-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}
