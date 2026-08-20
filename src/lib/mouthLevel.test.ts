import { expect, test } from "vitest";
import { mouthLevel, Desmoother, resampleToSdkLayout } from "./mouthLevel";

/**
 * Spectrum in the layout the SDK hands out: 100–8000 Hz spread linearly across the
 * bins, each byte a decibel on the -100..-30 scale. `bands` is Hz → byte level.
 */
function spectrum(bands: Array<[number, number, number]>, bins = 1024): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(bins));
  const at = (hz: number) => Math.round(((hz - 100) / 7900) * bins);
  for (const [from, to, value] of bands) out.fill(value, at(from), at(to));
  return out;
}

test("a vowel opens the mouth, quiet does not", () => {
  expect(mouthLevel(spectrum([[200, 900, 200]]))).toBeGreaterThan(0.4);
  expect(mouthLevel(spectrum([[200, 900, 10]]))).toBeLessThan(0.1);
});

test("a sibilant is loud and still reads as nearly shut", () => {
  // The promise of this module: openness is not loudness. /s/ carries more energy
  // than a vowel and is spoken through a closed mouth, so testing loudness alone
  // is how every sibilant came out wide open.
  const vowel = spectrum([[200, 900, 200]]);
  const sibilant = spectrum([[3000, 8000, 220]]);
  expect(mouthLevel(sibilant)).toBeLessThan(mouthLevel(vowel));
  expect(mouthLevel(sibilant)).toBeLessThan(0.1);
});

test("sibilant energy on top of a vowel closes the mouth further", () => {
  const vowel = mouthLevel(spectrum([[200, 900, 200]]));
  const both = mouthLevel(spectrum([[200, 900, 200], [3000, 8000, 200]]));
  expect(both).toBeLessThan(vowel);
});

test("no spectrum is not a level", () => {
  expect(mouthLevel(new Uint8Array(0))).toBe(0);
});

test("the same sound reads the same at a different bin count", () => {
  // Band edges come from the 100–8000 Hz layout, not from a bin width, so the
  // reading must not move with FFT size.
  const wide = mouthLevel(spectrum([[200, 900, 200]], 1024));
  const narrow = mouthLevel(spectrum([[200, 900, 200]], 256));
  expect(narrow).toBeCloseTo(wide, 1);
});

/** Feeds one spectrum repeatedly, the way the animation loop would. */
function settle(d: Desmoother, s: Uint8Array, frames = 4): Uint8Array {
  let out = s;
  for (let i = 0; i < frames; i++) out = d.apply(s);
  return out;
}

test("a held sound passes through unchanged", () => {
  // Steady state has nothing to recover: undoing the blend of a signal against
  // itself has to give back the signal, or every level is quietly wrong.
  const s = spectrum([[200, 900, 180]]);
  const out = settle(new Desmoother(), s);
  expect(mouthLevel(out)).toBeCloseTo(mouthLevel(s), 2);
});

test("the attack of a sound survives the analyser's smoothing", () => {
  // The defect this exists for: the analyser averaged speech flat over ~75 ms, so
  // the mouth held one frame through whole words. A rise has to read louder than
  // the smoothed byte that arrived, not equal to it.
  const quiet = spectrum([[200, 900, 20]]);
  const loud = spectrum([[200, 900, 200]]);

  const d = new Desmoother();
  settle(d, quiet);
  expect(mouthLevel(d.apply(loud))).toBeGreaterThan(mouthLevel(loud));
});

test("a sound stopping reads as stopped, not as fading", () => {
  const d = new Desmoother();
  settle(d, spectrum([[200, 900, 200]]));
  expect(mouthLevel(d.apply(spectrum([[200, 900, 0]])))).toBe(0);
});

test("a spectrum of a different size does not carry the old one's state", () => {
  const d = new Desmoother();
  settle(d, spectrum([[200, 900, 200]], 1024));
  expect(() => d.apply(spectrum([[200, 900, 200]], 512))).not.toThrow();
});

test("a resampled tone lands where the layout says, whatever the sample rate", () => {
  // The bench owns a real AnalyserNode; if its resample disagreed with the layout
  // `mouthLevel` assumes, the bench would measure a signal nothing else uses.
  const toneAt = (hz: number, sampleRate: number, fftBins: number) => {
    const fft = new Uint8Array(fftBins);
    const hzPerBin = sampleRate / 2 / fftBins;
    fft.fill(255, Math.round((hz - 150) / hzPerBin), Math.round((hz + 150) / hzPerBin));
    return resampleToSdkLayout(fft, sampleRate, 1024);
  };

  const at48k = toneAt(500, 48000, 1024);
  const at16k = toneAt(500, 16000, 512);
  expect(mouthLevel(at48k)).toBeGreaterThan(0.3);
  expect(mouthLevel(at16k)).toBeCloseTo(mouthLevel(at48k), 1);
});
