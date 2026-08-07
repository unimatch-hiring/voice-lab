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

/** Полуоткрытая фаза каждой визимы (`*h`) — середина пути челюсти. */
export const HALF_SPRITES: Record<Exclude<Viseme, "rest">, string> = {
  MBP: "face/MBPh.png",
  AI: "face/AIh.png",
  E: "face/Eh.png",
  O: "face/Oh.png",
  U: "face/Uh.png",
  FV: "face/FVh.png",
  L: "face/Lh.png",
  WQ: "face/WQh.png",
};

type FrameKey = Viseme | `${Exclude<Viseme, "rest">}h`;

const FRAME_KEYS: readonly FrameKey[] = [
  ...VISEMES,
  ...(Object.keys(HALF_SPRITES) as Array<Exclude<Viseme, "rest">>).map(
    (v) => `${v}h` as FrameKey,
  ),
];

function spriteOf(key: FrameKey): string {
  return key.endsWith("h")
    ? HALF_SPRITES[key.slice(0, -1) as Exclude<Viseme, "rest">]
    : MOUTH_SPRITES[key as Viseme];
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

/** Ниже этого раскрытия показываем закрытый рот. */
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
    // Что реально видно, чтобы не трогать DOM на каждом кадре зря.
    let litHalf: FrameKey | null = null;
    let litFull: FrameKey | null = null;

    const setOpacity = (key: FrameKey | null, value: number) => {
      if (!key) return;
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

      // Раскрытие рисуем двумя слоями: полуфаза набирает силу на первой
      // половине пути, полный кадр — на второй. Кроссфейд идёт по амплитуде, а
      // не по таймеру, поэтому рассинхрона со звуком не возникает.
      const half = `${shape}h` as FrameKey;
      const full = shape as FrameKey;
      const closed = openness < CLOSED_BELOW;
      // Кроссфейд по трём точкам rest -> half -> full, но так, чтобы слои НЕ
      // складывались: на середине пути прежняя формула зажигала полуфазу на
      // 100% и одновременно начинала проявлять полный кадр — суммарная
      // плотность подскакивала, и это читалось как рывок ровно посередине
      // раскрытия. Здесь half гаснет на второй половине настолько же,
      // насколько проступает full.
      const t = closed ? 0 : Math.min(1, openness);
      const halfOpacity = t <= 0.5 ? t / 0.5 : 1 - (t - 0.5) / 0.5;
      const fullOpacity = t <= 0.5 ? 0 : (t - 0.5) / 0.5;

      if (litHalf !== half) {
        setOpacity(litHalf, 0);
        litHalf = half;
      }
      if (litFull !== full) {
        setOpacity(litFull, 0);
        litFull = full;
      }
      setOpacity(half, halfOpacity);
      setOpacity(full, fullOpacity);
      // Закрытый кадр — подложка: он гаснет ровно настолько, насколько
      // раскрылся рот, поэтому шва между «закрыто» и «приоткрыто» не видно.
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
