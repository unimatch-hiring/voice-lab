import { useEffect, useRef, useState } from "react";
import type { EventBus } from "../lib/events";

/**
 * What the learner has got wrong, kept on screen under the conversation.
 *
 * One line per mistake, `what was said -> what English wants`, which is the form a
 * learner can read back and compare. The count is in the header because that is the
 * question asked about a list like this ("how many did I make?"), and reading it off
 * the lines means counting them.
 *
 * The lines and the count are written straight to the DOM rather than through state,
 * like `Transcript`: the rule here is that renders must not track the event stream,
 * and a board that re-rendered on each mistake would also lose whatever the reader had
 * selected to copy. Only "is there anything to clear" is state, which changes at most
 * twice a lesson — and it has to be, because React will not deliver a click to a
 * button its own props call disabled, however the DOM flag was set.
 *
 * The textarea is read-only. It is a record, not an input — but a textarea rather
 * than a block of text because it scrolls, selects and copies, which is what somebody
 * does with a list of their own mistakes.
 */
export function MistakeBoard({ bus, onClear }: { bus: EventBus; onClear: () => void }) {
  const countRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const [anything, setAnything] = useState(false);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;

    const show = (total: number) => {
      if (countRef.current) countRef.current.textContent = String(total);
      // Unchanged on every mistake after the first, so React stops here rather than
      // rendering: the stream does not drive renders, a crossing does.
      setAnything(total > 0);
    };

    return bus.on((e) => {
      if (e.type === "mistakes-cleared") {
        log.value = "";
        show(0);
        return;
      }
      if (e.type !== "mistake") return;

      const line = `${e.said} -> ${e.fixed}`;
      log.value = log.value ? `${log.value}\n${line}` : line;
      // Keep the newest line in view, the way the conversation does.
      log.scrollTop = log.scrollHeight;
      show(e.total);
    });
  }, [bus]);

  return (
    <div className="mistakes">
      <div className="mistakes-head">
        <span>mistakes</span>
        <span className="spacer" />
        <span>
          corrected <b className="readout" ref={countRef}>0</b>
        </span>
        <button
          type="button"
          className="settings-secondary"
          onClick={onClear}
          disabled={!anything}
        >
          Clear
        </button>
      </div>
      <textarea
        ref={logRef}
        className="mistakes-log"
        readOnly
        spellCheck={false}
        aria-label="Mistakes and their corrections"
        placeholder="Nothing corrected yet. Mistakes land here as you said them, next to what English wants."
      />
    </div>
  );
}
