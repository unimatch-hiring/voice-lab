import { useEffect, useState } from "react";
import type { EventBus } from "../lib/events";

/**
 * The learner's level, and the one control that changes it.
 *
 * State rather than a direct DOM write, unlike its neighbours: this changes once or
 * twice a lesson, and the button's label depends on it. The rule it would otherwise
 * break is about the event stream causing renders — a level is not that stream.
 */
export function LevelLine({ bus, onReset }: { bus: EventBus; onReset: () => void }) {
  const [level, setLevel] = useState<string | null>(null);
  const [told, setTold] = useState(false);

  useEffect(
    () =>
      bus.on((e) => {
        if (e.type !== "level") return;
        setLevel(e.level);
        setTold(e.told);
      }),
    [bus],
  );

  return (
    <div className="level-line">
      <span>level</span>
      <b className="readout">{level ?? "—"}</b>
      <span className="level-source">
        {level === null
          ? "not set — you will be asked"
          : told
            ? "you said so"
            : "from how you speak"}
      </span>
      <span className="spacer" />
      {level !== null && (
        // No double-press guard: the reset is synchronous and takes the button with
        // it, since there is no longer a level to reset.
        <button type="button" className="settings-secondary" onClick={onReset}>
          Reset level
        </button>
      )}
    </div>
  );
}
