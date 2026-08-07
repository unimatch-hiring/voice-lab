import { expect, test } from "vitest";
import { render } from "@testing-library/react";
import { Mouth, MOUTH_SPRITES } from "./Mouth";
import { VisemeTimeline } from "../lib/visemes";
import type { Viseme } from "../lib/visemes";

const VISEMES: Viseme[] = ["rest", "MBP", "AI", "E", "O", "U", "FV", "L", "WQ"];

test("ships a sprite for every viseme", () => {
  for (const v of VISEMES) {
    expect(MOUTH_SPRITES[v], `нет спрайта для ${v}`).toBeTruthy();
    expect(MOUTH_SPRITES[v].endsWith(".png")).toBe(true);
  }
});

test("every viseme maps to its own file", () => {
  const files = VISEMES.map((v) => MOUTH_SPRITES[v]);
  expect(new Set(files).size).toBe(VISEMES.length);
});

/** Визима первого символа фразы — по ней проверяем стартовый кадр. */
function timelineOf(chars: string[], durMs = 100): VisemeTimeline {
  const t = new VisemeTimeline();
  t.append({
    audio: new Int16Array(0),
    chars,
    charStartTimesMs: chars.map((_, i) => i * durMs),
    charDurationsMs: chars.map(() => durMs),
  });
  return t;
}

/**
 * Какая форма рта сейчас проступает и насколько раскрыт рот (0..1).
 *
 * Слои складываются с постоянной суммой: до половины пути набирает полуфаза,
 * после — полный кадр гасит её ровно настолько, насколько проступает сам.
 * Поэтому раскрытие восстанавливаем как `half/2` на первой половине и
 * `0.5 + full/2` на второй, а не как сумму прозрачностей.
 */
function readMouth(container: HTMLElement) {
  const lit = ([...container.querySelectorAll("img")] as HTMLImageElement[])
    .map((el) => ({
      name: el.getAttribute("src")!.split("/").pop()!.replace(".png", ""),
      opacity: Number(el.style.opacity),
    }))
    .filter((f) => f.name !== "rest" && f.opacity > 0.01);
  const full = lit.find((f) => !f.name.endsWith("h"));
  const half = lit.find((f) => f.name.endsWith("h"));
  const openness = full
    ? 0.5 + (full.opacity / 2)
    : half
      ? half.opacity / 2
      : 0;
  const shape = lit.length
    ? lit.reduce((a, b) => (b.opacity > a.opacity ? b : a)).name.replace(/h$/, "")
    : "rest";
  return { shape, openness };
}

test("mouth follows the audio playhead, not a wall clock", () => {
  const timeline = timelineOf(["м", "а"]);
  // Плейхед стоит: аудио не играет.
  const playback = { elapsedMs: 0, isPlaying: false, enqueue: () => {}, stop: () => {} };

  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;

  try {
    const { container } = render(
      <Mouth timeline={timeline} playback={playback as never} />,
    );

    // Кадры крутятся с разным временем, плейхед не двигается — форма стоит.
    for (let i = 0; i < 60; i++) frames.splice(0).forEach((cb) => cb(i * 16));
    expect(readMouth(container).shape).toBe("MBP");
    const held = readMouth(container).openness;
    for (let i = 0; i < 20; i++) frames.splice(0).forEach((cb) => cb(1000 + i * 16));
    expect(readMouth(container).openness, "плейхед стоит — рот не движется").toBeCloseTo(
      held,
      1,
    );

    // Двигаем ТОЛЬКО плейхед — форма обязана поехать к следующей визиме.
    playback.elapsedMs = 150;
    for (let i = 0; i < 20; i++) frames.splice(0).forEach((cb) => cb(2000 + i * 16));
    expect(readMouth(container).shape).toBe("AI");
    expect(MOUTH_SPRITES.AI).toBeTruthy();
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});

test("рот едет к форме, а не прыгает в неё", () => {
  // Спрайты сняты широко открытыми, поэтому дискретная смена кадра — всегда
  // скачок амплитуды: именно он и читался как дёрганье. Раскрытие должно
  // набираться постепенно, за несколько кадров анимации.
  // Визима длинная: со сглаживанием ~200 мс на коротком слоге рот законно не
  // успевает распахнуться до конца, и проверять на нём амплитуду нечестно.
  const timeline = timelineOf(["а"], 800);
  const playback = { elapsedMs: 0, isPlaying: true, enqueue: () => {}, stop: () => {} };

  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;

  try {
    const { container } = render(
      <Mouth timeline={timeline} playback={playback as never} />,
    );

    const seen: number[] = [];
    // 60 кадров ~ 1 c: со сглаживанием ~200 мс до цели рот успевает доехать.
    for (let i = 0; i < 60; i++) {
      playback.elapsedMs = i * 16;
      frames.splice(0).forEach((cb) => cb(playback.elapsedMs));
      seen.push(readMouth(container).openness);
    }

    expect(seen[0], "на первом кадре рот ещё почти закрыт").toBeLessThan(0.25);
    expect(Math.max(...seen), "к концу визимы рот раскрыт").toBeGreaterThan(0.5);

    let maxJump = 0;
    for (let i = 1; i < seen.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(seen[i] - seen[i - 1]));
    }
    // Ступенька «закрыто → распахнуто» дала бы скачок около 1.0.
    expect(maxJump, "амплитуда меняется плавно, без ступеньки").toBeLessThan(0.3);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});

test("форма держится достаточно долго, чтобы её было видно", () => {
  // Референсная практика 2D-липсинка: frame-holding. Без него форма скачет
  // чаще, чем глаз читает как речь, — рот дрожит.
  const timeline = timelineOf(["м", "а", "о", "у", "и"], 40);
  const playback = { elapsedMs: 0, isPlaying: true, enqueue: () => {}, stop: () => {} };

  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;

  try {
    const { container } = render(
      <Mouth timeline={timeline} playback={playback as never} />,
    );

    const shapes: string[] = [];
    for (let i = 0; i < 40; i++) {
      playback.elapsedMs = Math.round(i * 16.7);
      frames.splice(0).forEach((cb) => cb(playback.elapsedMs));
      shapes.push(readMouth(container).shape);
    }

    // Считаем серии подряд идущих одинаковых форм.
    const lengths: number[] = [];
    for (let i = 0; i < shapes.length; i++) {
      if (i === 0 || shapes[i] !== shapes[i - 1]) lengths.push(1);
      else lengths[lengths.length - 1]++;
    }
    const flicker = lengths.filter((n) => n === 1).length;
    expect(flicker, `форм, мелькнувших на один кадр: ${flicker}`).toBeLessThanOrEqual(1);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});
