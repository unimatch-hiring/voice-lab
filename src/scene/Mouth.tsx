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

type Shape = Exclude<Viseme, "rest">;

/** Четверть раскрытия (`*q`) — первая треть пути челюсти. */
export const QUARTER_SPRITES: Record<Shape, string> = {
  MBP: "face/MBPq.png",
  AI: "face/AIq.png",
  E: "face/Eq.png",
  O: "face/Oq.png",
  U: "face/Uq.png",
  FV: "face/FVq.png",
  L: "face/Lq.png",
  WQ: "face/WQq.png",
};

/** Полуоткрытая фаза (`*h`) — середина пути челюсти. */
export const HALF_SPRITES: Record<Shape, string> = {
  MBP: "face/MBPh.png",
  AI: "face/AIh.png",
  E: "face/Eh.png",
  O: "face/Oh.png",
  U: "face/Uh.png",
  FV: "face/FVh.png",
  L: "face/Lh.png",
  WQ: "face/WQh.png",
};

type FrameKey = Viseme | `${Shape}h` | `${Shape}q`;

const SHAPES = Object.keys(HALF_SPRITES) as Shape[];

const FRAME_KEYS: readonly FrameKey[] = [
  ...VISEMES,
  ...SHAPES.map((v) => `${v}h` as FrameKey),
  ...SHAPES.map((v) => `${v}q` as FrameKey),
];

function spriteOf(key: FrameKey): string {
  if (key.endsWith("q")) return QUARTER_SPRITES[key.slice(0, -1) as Shape];
  if (key.endsWith("h")) return HALF_SPRITES[key.slice(0, -1) as Shape];
  return MOUTH_SPRITES[key as Viseme];
}

/**
 * Кадры одной визимы по возрастанию раскрытия. Сборщик спрайтов гарантирует
 * этот порядок по факту (он переставляет фазы, если генератор промахнулся), так
 * что интерполировать между соседями безопасно.
 */
function phasesOf(shape: Shape): readonly FrameKey[] {
  return ["rest", `${shape}q` as FrameKey, `${shape}h` as FrameKey, shape as FrameKey];
}

/**
 * Целевая амплитуда раскрытия на визиму. Спрайты сняты широко открытыми, но
 * фонемы раскрывают рот по-разному: /м/ смыкает губы, /а/ распахивает.
 * Замер тёмной полости по кадрам: MBP/WQ/FV/U ~17-19%, E/O/L ~23-25%, AI ~26%.
 */
const OPENNESS: Record<Viseme, number> = {
  rest: 0,
  MBP: 0.25,
  WQ: 0.4,
  FV: 0.45,
  U: 0.5,
  E: 0.75,
  L: 0.8,
  O: 0.85,
  AI: 1,
};

/**
 * Сглаживание амплитуды за кадр (экспоненциальное, ~200 мс до цели). Челюсть —
 * инерционная механика: она не прыгает между формами, а едет к цели. Именно
 * этого не давала прежняя схема «дискретный кадр + CSS-fade»: на 10-15 сменах
 * в секунду fade не успевал завершиться, кадры мелькали по 16 мс и всё
 * читалось как дрожь. Здесь дрожать нечему — амплитуда непрерывна.
 *
 * Цена сглаживания — рот не доходит до крайних форм и отстаёт от звука, но она
 * мала: замер на русской фикстуре даёт размах 0.81 из 0.90 и запаздывание 33 мс
 * (на глаз незаметно), тогда как рывок падает в 3.5 раза против 0.014.
 */
const SMOOTH_PER_MS = 0.005;

/** Шаг кадра анимации при 60 Hz — по нему идёт инерция челюсти. */
const FRAME_MS = 16.7;

/**
 * Минимум, сколько держится ФОРМА рта (какой из восьми кадров показываем).
 * Референсная практика 2D-липсинка — frame-holding на ~3 кадра: без него форма
 * скачет чаще, чем глаз способен прочитать как артикуляцию.
 */
const SHAPE_HOLD_MS = 150;

/**
 * Мёртвая зона у закрытого рта: ниже этого раскрытия рот считаем сомкнутым.
 * Амплитуда не обрубается на пороге, а растягивается от него — иначе на входе
 * в речь рот открывался рывком.
 */
const CLOSED_BELOW = 0.12;

export function Mouth({
  timeline,
  playback,
}: {
  timeline: VisemeTimeline;
  playback: PlaybackLike;
}) {
  const frames = useRef(new Map<FrameKey, HTMLImageElement>());

  useEffect(() => {
    let raf = 0;
    let openness = 0;
    // Форма живёт своей шкалой: цель приходит из таймлайна, но меняем её не
    // чаще SHAPE_HOLD_MS, иначе рот перебирает формы быстрее, чем видно.
    let shape: Exclude<Viseme, "rest"> = "AI";
    let shapeAt = -Infinity;
    // Какие кадры сейчас подсвечены — чтобы гасить их при смене формы, а не
    // перебирать все 25 на каждом тике.
    let lit: FrameKey[] = [];

    const setOpacity = (key: FrameKey, value: number) => {
      const el = frames.current.get(key);
      if (el) el.style.opacity = value.toFixed(3);
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Шкал две, и это осознанно. ЦЕЛЬ раскрытия читаем по плейхеду аудио —
      // иначе рот разошёлся бы со звуком. А вот ИНЕРЦИЮ челюсти считаем по
      // кадрам анимации: пока аудио на паузе, `elapsedMs` не растёт, и по нему
      // рот застыл бы на полпути к форме.
      const now = playback.elapsedMs;
      const viseme = timeline.at(now);
      if (viseme !== "rest" && viseme !== shape && now - shapeAt >= SHAPE_HOLD_MS) {
        shape = viseme;
        shapeAt = now;
      }

      // Экспоненциальное приближение к цели: величина шага пропорциональна
      // остатку, поэтому старт быстрый, а подход к форме мягкий.
      const target = OPENNESS[viseme];
      const k = 1 - Math.exp(-SMOOTH_PER_MS * FRAME_MS);
      openness += (target - openness) * k;

      // Амплитуду раскладываем по четырём кадрам (rest -> q -> h -> полный):
      // находим сегмент, в котором находимся, и показываем ровно двух соседей с
      // весами, дающими в СУММЕ единицу. Постоянная сумма принципиальна: пока
      // слои складывались, на второй половине раскрытия горели два кадра по
      // 100%, суммарная плотность доходила до 2.0 и это читалось как рывок
      // посередине движения. Три сегмента вместо одного дают вчетверо меньший
      // шаг между соседними позами.
      const phases = phasesOf(shape);
      // Порог тишины растягиваем, а не обрубаем. Пока он просто обнулял
      // амплитуду, на его пересечении сумма непрозрачности прыгала с 0 сразу на
      // 0.36 — рот «включался» рывком на каждом входе в речь.
      const t = Math.min(
        1,
        Math.max(0, (openness - CLOSED_BELOW) / (1 - CLOSED_BELOW)),
      );
      const seg = Math.min(phases.length - 2, Math.floor(t * (phases.length - 1)));
      const frac = t * (phases.length - 1) - seg;
      const lower = phases[seg];
      const upper = phases[seg + 1];

      for (const key of lit) {
        if (key !== lower && key !== upper && key !== "rest") setOpacity(key, 0);
      }
      lit = [lower, upper];
      if (lower !== "rest") setOpacity(lower, 1 - frac);
      setOpacity(upper, frac);
      // Закрытый кадр — подложка: остальные слои проявляются поверх него,
      // поэтому шва между «закрыто» и «приоткрыто» не видно.
      setOpacity("rest", 1);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timeline, playback]);

  return (
    <figure className="mouth-frame" aria-label="Артикуляция ответа">
      <div className="mouth-stack">
        {FRAME_KEYS.map((k) => (
          <img
            key={k}
            ref={(el) => {
              if (el) frames.current.set(k, el);
              else frames.current.delete(k);
            }}
            src={`${import.meta.env.BASE_URL}${spriteOf(k)}`}
            alt=""
            draggable={false}
            // Ноль CSS-переходов: амплитуду ведёт rAF, а transition поверх неё
            // добавил бы второй, независимый источник времени.
            style={{ opacity: k === "rest" ? 1 : 0 }}
          />
        ))}
      </div>
    </figure>
  );
}
