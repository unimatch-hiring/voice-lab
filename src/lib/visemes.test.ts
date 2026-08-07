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
  expect(t.at(500)).toBe("rest"); // past the end the mouth is closed
});

test("chunk timestamps are relative, so the second chunk is offset by the first", () => {
  const t = new VisemeTimeline();
  t.append(chunk(["m"], [0], [100]));   // 0..100 absolute
  t.append(chunk(["o"], [0], [100]));   // starts at 0 again -> must become 100..200

  expect(t.at(50)).toBe("MBP");
  expect(t.at(150)).toBe("O");
  expect(t.totalMs).toBe(200);
});

test("a gap between chunks does not desync later chunks", () => {
  const t = new VisemeTimeline();
  // The first chunk ends at 100, but has a pause inside it: the last char starts at 60.
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

test("the timeline advances by the audio's length, not the alignment's", () => {
  // Alignment describes only the characters it covers, so anchoring to it left the
  // mouth running ahead of the voice — and the gap grew with every chunk.
  const t = new VisemeTimeline();

  t.append(
    {
      audio: new Int16Array(16000),
      chars: ["а"],
      charStartTimesMs: [0],
      charDurationsMs: [100], // alignment says 100 ms, the audio plays for 1000
    },
    1000,
  );

  expect(t.totalMs, "a second of audio moves the timeline a second").toBe(1000);
});

test("a chunk without alignment still advances the timeline", () => {
  // Audio can arrive with no alignment. Advancing by zero put every later chunk back
  // at the start of the reply, so the mouth animated the first chunk and then froze
  // while the voice kept going.
  const t = new VisemeTimeline();

  t.append(
    { audio: new Int16Array(16000), chars: [], charStartTimesMs: [], charDurationsMs: [] },
    1000,
  );
  expect(t.totalMs, "one second of audio moves the timeline a second").toBe(1000);

  t.append({
    audio: new Int16Array(0),
    chars: ["а"],
    charStartTimesMs: [0],
    charDurationsMs: [100],
  });
  expect(t.at(1050), "the next chunk lands after the silent one, not on top of it").toBe("AI");
});
