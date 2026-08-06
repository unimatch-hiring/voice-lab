import { useEffect, useRef } from "react";
import type { Viseme, VisemeTimeline } from "../lib/visemes";
import type { PlaybackLike } from "../lib/pipeline/orchestrator";

/** 8 форм Preston Blair плюс покой. Координаты в системе 100×60. */
export const MOUTH_SHAPES: Record<Viseme, string> = {
  rest: "M20,30 Q50,34 80,30 Q50,36 20,30 Z",
  MBP:  "M20,30 Q50,32 80,30 Q50,33 20,30 Z",
  AI:   "M22,26 Q50,14 78,26 Q50,52 22,26 Z",
  E:    "M20,28 Q50,20 80,28 Q50,40 20,28 Z",
  O:    "M34,30 Q50,16 66,30 Q50,46 34,30 Z",
  U:    "M40,30 Q50,22 60,30 Q50,40 40,30 Z",
  FV:   "M22,31 Q50,25 78,31 Q50,35 22,31 Z",
  L:    "M24,28 Q50,22 76,28 Q50,42 24,28 Z",
  WQ:   "M38,30 Q50,20 62,30 Q50,42 38,30 Z",
};

export function Mouth({
  timeline,
  playback,
}: {
  timeline: VisemeTimeline;
  playback: PlaybackLike;
}) {
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    let raf = 0;
    let current: Viseme | null = null;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Единственный источник времени — плейхед аудио. Свой таймер здесь
      // означал бы две независимые шкалы и гарантированный расход.
      const viseme = timeline.at(playback.elapsedMs);
      if (viseme !== current) {
        current = viseme;
        pathRef.current?.setAttribute("d", MOUTH_SHAPES[viseme]);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timeline, playback]);

  return (
    <svg viewBox="0 0 100 60" width="120" height="72" aria-label="Артикуляция ответа">
      <path
        ref={pathRef}
        d={MOUTH_SHAPES.rest}
        fill="var(--ink, #10151c)"
        style={{ transition: "d 40ms linear" }}
      />
    </svg>
  );
}
