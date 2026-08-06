import { useEffect, useRef } from "react";
import type { Viseme, VisemeTimeline } from "../lib/visemes";
import type { PlaybackLike } from "../lib/pipeline/orchestrator";

const VISEMES: readonly Viseme[] = [
  "rest", "MBP", "AI", "E", "O", "U", "FV", "L", "WQ",
];

/** Кадр персонажа на визиму. Спрайты лежат в public/face/. */
export const MOUTH_SPRITES: Record<Viseme, string> = {
  rest: "face/rest.png",
  MBP: "face/MBP.png",
  AI: "face/AI.png",
  E: "face/E.png",
  O: "face/O.png",
  U: "face/U.png",
  FV: "face/FV.png",
  L: "face/L.png",
  WQ: "face/WQ.png",
};

export function Mouth({
  timeline,
  playback,
}: {
  timeline: VisemeTimeline;
  playback: PlaybackLike;
}) {
  const frames = useRef(new Map<Viseme, HTMLImageElement>());

  useEffect(() => {
    let raf = 0;
    // Стартовое значение — тот кадр, что реально виден в разметке, иначе первое
    // переключение не погасит его и на экране окажутся два кадра сразу.
    let current: Viseme = "rest";

    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Единственный источник времени — плейхед аудио. Свой таймер здесь
      // означал бы две независимые шкалы и гарантированный расход.
      const viseme = timeline.at(playback.elapsedMs);
      if (viseme === current) return;

      // Показ через visibility, а не через смену src: все кадры уже в DOM,
      // поэтому переключение не ждёт сети и не моргает на первом показе.
      const prev = frames.current.get(current);
      if (prev) prev.style.opacity = "0";
      const next = frames.current.get(viseme);
      if (next) next.style.opacity = "1";
      current = viseme;
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timeline, playback]);

  return (
    <div
      style={{ position: "relative", width: 160, height: 160 }}
      aria-label="Артикуляция ответа"
    >
      {VISEMES.map((v) => (
        <img
          key={v}
          ref={(el) => {
            if (el) frames.current.set(v, el);
            else frames.current.delete(v);
          }}
          src={`${import.meta.env.BASE_URL}${MOUTH_SPRITES[v]}`}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: v === "rest" ? 1 : 0,
            userSelect: "none",
          }}
        />
      ))}
    </div>
  );
}
