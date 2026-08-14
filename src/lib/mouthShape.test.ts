import { expect, test } from "vitest";
import { shapeOf } from "./mouthShape";
import { mouthLevel } from "./mouthLevel";
import { frameOf, step, INITIAL } from "./mouthFrame";

/**
 * Spectrum in the layout the SDK hands out: 100–8000 Hz spread linearly across the
 * bins, each byte a decibel on the -100..-30 scale. `bands` is Hz → byte level.
 */
function spectrum(bands: Array<[number, number, number]>): Uint8Array {
  const bins = 1024;
  const out = new Uint8Array(new ArrayBuffer(bins));
  const at = (hz: number) => Math.round(((hz - 100) / 7900) * bins);
  for (const [from, to, value] of bands) out.fill(value, at(from), at(to));
  return out;
}

test("a fricative reads as the narrow mouth, not an open one", () => {
  // /s/ carries more energy than a vowel, most of it above 4 kHz. Testing loudness
  // before spectrum shape is how every sibilant came out as a wide-open mouth.
  expect(shapeOf(spectrum([[4000, 8000, 220], [300, 1000, 60]]))).toBe("FV");
});

test("energy only in the fundamental is a closed pair of lips", () => {
  expect(shapeOf(spectrum([[100, 250, 200]]))).toBe("MBP");
});

test("an open vowel reads as the open mouth", () => {
  // /a/: the first formant sits high in its band, around 700 Hz.
  expect(shapeOf(spectrum([[100, 250, 150], [500, 1000, 200], [250, 500, 60]]))).toBe("AI");
});

test("a second formant well above the first is a rounded mouth", () => {
  expect(
    shapeOf(spectrum([[100, 250, 150], [250, 500, 120], [500, 1000, 60], [1000, 2500, 190]])),
  ).toBe("O");
});

test("sustained vowels do not all collapse into one shape", () => {
  // The first version measured every ratio against total energy, where the
  // fundamental of a voice at ~200 Hz is two thirds of everything. Every vowel
  // landed in the same bucket, and a recording of nothing but held vowels animated
  // as a single mouth.
  const vowels = [
    spectrum([[100, 250, 170], [500, 1000, 210], [250, 500, 70]]),
    spectrum([[100, 250, 170], [250, 500, 130], [1000, 2500, 200]]),
    spectrum([[100, 250, 200], [250, 500, 180], [500, 1000, 90]]),
  ];
  expect(new Set(vowels.map(shapeOf)).size).toBeGreaterThan(1);
});

test("silence shuts the mouth whatever shape is guessed for it", () => {
  // An empty spectrum has no shape to read, and the classifier still answers —
  // every band is at the floor, so the ratios come out of noise. The level is what
  // has to shut the mouth, and it must not depend on that answer being sensible.
  const quiet = spectrum([]);
  expect(mouthLevel(quiet)).toBe(0);

  let state = INITIAL;
  for (let i = 0; i < 60; i++) state = step(state, mouthLevel(quiet), shapeOf(quiet), 16.7);
  expect(frameOf(state)).toBe("rest");
});
