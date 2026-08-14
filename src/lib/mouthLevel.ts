/**
 * How far the mouth should be open, 0..1, from the spectrum of the audio playing.
 * Band choice and why not plain loudness: docs/mouth.md
 *
 * Shared by the live session and by the bench, so both read the same number from
 * the same audio — a bench that measured loudness its own way would agree with
 * production only by accident.
 */

/** The SDK resamples this range linearly across the spectrum it hands out. */
const SPECTRUM_FROM_HZ = 100;
const SPECTRUM_TO_HZ = 8000;

/** Bytes are decibels on a linear scale from -100 to -30 (Web Audio default). */
const MIN_DB = -100;
const MAX_DB = -30;

/** How far the jaw drops on a vowel. */
const JAW_FROM_HZ = 200;
const JAW_TO_HZ = 900;

/** Sibilants: loud, but spoken through a nearly shut mouth. */
const SIBILANT_FROM_HZ = 3000;

/** How strongly sibilant energy closes the mouth. */
const SIBILANT_CLOSE = 0.6;

/**
 * Bin index for a frequency. Bins are a linear resample of 100–8000 Hz across
 * the array, not raw FFT bins, so this is independent of sample rate and FFT size.
 */
function binOf(hz: number, bins: number): number {
  const t = (hz - SPECTRUM_FROM_HZ) / (SPECTRUM_TO_HZ - SPECTRUM_FROM_HZ);
  return Math.round(t * bins);
}

function band(spectrum: Uint8Array, fromHz: number, toHz: number): number {
  const n = spectrum.length;
  const lo = Math.max(0, Math.min(n - 1, binOf(fromHz, n)));
  const hi = Math.max(lo + 1, Math.min(n, binOf(toHz, n)));
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += spectrum[i];
  return sum / (hi - lo) / 255;
}

export function mouthLevel(spectrum: Uint8Array): number {
  if (spectrum.length === 0) return 0;
  const jaw = band(spectrum, JAW_FROM_HZ, JAW_TO_HZ);
  const sibilant = band(spectrum, SIBILANT_FROM_HZ, SPECTRUM_TO_HZ);
  // Sibilants are energetic but nearly closed, so they subtract.
  return Math.max(0, jaw - sibilant * SIBILANT_CLOSE);
}

/**
 * How much of the analyser's smoothing to take back out.
 *
 * Not all of it. Undoing the full 0.8 left the signal asking for a different frame
 * on every tick of the hold — measured on the bench, the median time a frame stayed
 * on screen fell to exactly the 70 ms floor, which is a mouth chattering at the
 * limiter rather than articulating. This leaves a shorter time constant in place:
 * about 25 ms instead of 75.
 */
const SDK_SMOOTHING = 0.55;

/**
 * Undoes the analyser's own smoothing.
 *
 * `AnalyserNode` blends each spectrum with the previous one at 0.8, which over
 * 60 Hz sampling is a time constant near 75 ms — the exact scale speech articulates
 * on. Reading that signal, the mouth would hold one frame for 300–500 ms through
 * ordinary words, because the number driving it had been averaged flat. Given the
 * blend and the previous input, the current one is recoverable:
 * `x = (s - k·s_prev) / (1 - k)`.
 *
 * Stateful, so one instance per animation loop, and it must be fed every frame.
 * Averaging happens in linear magnitude, not in the decibels the bytes carry, so
 * the arithmetic has to convert both ways.
 */
export class Desmoother {
  private prev: Float64Array | null = null;

  apply(spectrum: Uint8Array): Uint8Array {
    const n = spectrum.length;
    if (!this.prev || this.prev.length !== n) this.prev = new Float64Array(n);

    const out = new Uint8Array(new ArrayBuffer(n));
    for (let i = 0; i < n; i++) {
      const db = MIN_DB + (spectrum[i] / 255) * (MAX_DB - MIN_DB);
      const linear = 10 ** (db / 20);
      // Negative means the band is falling faster than the blend can follow; the
      // true magnitude is simply small, so clamping at zero is the honest floor.
      const raw = Math.max(0, (linear - SDK_SMOOTHING * this.prev[i]) / (1 - SDK_SMOOTHING));
      this.prev[i] = linear;

      const outDb = raw > 0 ? 20 * Math.log10(raw) : MIN_DB;
      const clamped = Math.min(MAX_DB, Math.max(MIN_DB, outDb));
      out[i] = Math.round(((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * 255);
    }
    return out;
  }
}

/**
 * Resamples a raw FFT spectrum onto the 100–8000 Hz layout `mouthLevel` expects.
 * Only the bench needs this: it owns a real AnalyserNode, whereas the SDK already
 * hands out a spectrum in that layout.
 */
export function resampleToSdkLayout(
  fft: Uint8Array,
  sampleRate: number,
  bins = 1024,
): Uint8Array {
  const out = new Uint8Array(bins);
  const hzPerBin = sampleRate / 2 / fft.length;
  for (let i = 0; i < bins; i++) {
    const hz = SPECTRUM_FROM_HZ + (i / bins) * (SPECTRUM_TO_HZ - SPECTRUM_FROM_HZ);
    out[i] = fft[Math.min(fft.length - 1, Math.round(hz / hzPerBin))] ?? 0;
  }
  return out;
}
