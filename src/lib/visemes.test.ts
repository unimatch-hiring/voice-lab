import { expect, test } from "vitest";
import { charToViseme, VisemeTimeline } from "./visemes";
import type { TtsChunk } from "./types";

const chunk = (chars: string[], starts: number[], durs: number[]): TtsChunk => ({
  audio: new Int16Array(0),
  chars,
  charStartTimesMs: starts,
  charDurationsMs: durs,
});

test("maps latin and cyrillic vowels to viseme shapes", () => {
  expect(charToViseme("a")).toBe("AI");
  expect(charToViseme("А")).toBe("AI");
  expect(charToViseme("o")).toBe("O");
  expect(charToViseme("у")).toBe("U");
  expect(charToViseme("m")).toBe("MBP");
  expect(charToViseme("б")).toBe("MBP");
  expect(charToViseme("f")).toBe("FV");
  expect(charToViseme(" ")).toBe("rest");
  expect(charToViseme("ё")).toBe("O");
  expect(charToViseme("э")).toBe("E");
  expect(charToViseme("в")).toBe("FV");
});

test("reads the viseme active at a given moment", () => {
  const t = new VisemeTimeline();
  t.append(chunk(["m", "a"], [0, 100], [100, 200]));

  expect(t.at(50)).toBe("MBP");
  expect(t.at(150)).toBe("AI");
  expect(t.at(500)).toBe("rest"); // после конца — рот закрыт
});

test("chunk timestamps are relative, so the second chunk is offset by the first", () => {
  const t = new VisemeTimeline();
  t.append(chunk(["m"], [0], [100]));   // 0..100 абсолютных
  t.append(chunk(["o"], [0], [100]));   // снова начинается с 0 -> должно стать 100..200

  expect(t.at(50)).toBe("MBP");
  expect(t.at(150)).toBe("O");
  expect(t.totalMs).toBe(200);
});

test("a gap between chunks does not desync later chunks", () => {
  const t = new VisemeTimeline();
  // Первый чанк кончается на 100, но внутри есть пауза: последний символ стартует с 60.
  t.append(chunk(["m", " "], [0, 60], [60, 40]));
  t.append(chunk(["o"], [0], [100]));

  expect(t.totalMs).toBe(200);
  expect(t.at(150)).toBe("O");
});

test("chunk offset uses the latest-ending char, not the last char in order", () => {
  const t = new VisemeTimeline();
  t.append(chunk(["a", "b", "c"], [0, 50, 60], [50, 200, 20]));
  t.append(chunk(["o"], [0], [100]));

  expect(t.totalMs).toBe(350);
  expect(t.at(300)).toBe("O");
});

test("reset clears accumulated offset", () => {
  const t = new VisemeTimeline();
  t.append(chunk(["m"], [0], [100]));
  t.reset();
  t.append(chunk(["o"], [0], [100]));

  expect(t.at(50)).toBe("O");
  expect(t.totalMs).toBe(100);
});
