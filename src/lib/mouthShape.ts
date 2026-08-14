import type { Shape } from "./mouthFrames";

/**
 * Which mouth the sound being played wants, from its spectrum alone.
 *
 * The mouth used to take its shape from the character timings the provider sends
 * and its moment from a wall clock started when the agent said it had begun
 * speaking. Neither survives contact with a real connection: the timings do not
 * arrive for every chunk, and the clock starts when a packet lands rather than
 * when a speaker moves, so the two drifted apart by a different amount on every
 * run. That is what "sometimes it lip-syncs and sometimes it does not" was.
 *
 * The spectrum cannot drift: it is the sound leaving the speaker this frame. The
 * price is that it does not know letters, so /b/ and /d/ are one picture — which
 * the sprite set could not tell apart anyway (see mouthFrames.ts).
 */

/** Bytes are decibels on a linear scale from -100 to -30 (Web Audio default). */
const MIN_DB = -100;
const MAX_DB = -30;

const SPECTRUM_FROM_HZ = 100;
const SPECTRUM_TO_HZ = 8000;

/**
 * Thresholds live together so they can be recalibrated as one table.
 *
 * Set from percentiles of the recorded fixtures rather than by ear, and in-sample:
 * one TTS voice, one language, mp3 rather than the Opus a live call carries. The
 * bench replays those fixtures, so moving a number and seeing the result costs one
 * page reload. Expect to move `sibilant` first if another voice reads every /s/ as
 * a wide-open mouth.
 */
const SHAPE_THRESHOLDS = {
  /**
   * Share of ALL energy above 4 kHz, the fundamental included. Measured against
   * the articulatory bands alone, a voice with nothing above its fundamental —
   * a nasal, or a held /m/ — leaves those bands sitting on the noise floor in
   * equal amounts, and one quarter of nothing counts as a fricative. Top ~6% of
   * voiced frames.
   */
  sibilant: 0.065,
  /** Articulatory energy against the fundamental. The bottom ~15%: lips together. */
  closure: 0.3,
  /** Where the first formant sits inside its own band. High means an open jaw. */
  open: 0.45,
  /** Second formant against the first: rounded and front vowels. */
  front: 0.22,
};

function binOf(hz: number, bins: number): number {
  const t = (hz - SPECTRUM_FROM_HZ) / (SPECTRUM_TO_HZ - SPECTRUM_FROM_HZ);
  return Math.round(t * bins);
}

/**
 * Mean power of a band in linear units.
 *
 * Averaging the raw bytes would average decibels, where a bin at 200 and a bin at
 * 100 differ by a factor of ~30 in power but only 2 in the number. Ratios between
 * bands are the whole method here, so they have to be ratios of energy.
 */
function bandPower(spectrum: Uint8Array, fromHz: number, toHz: number): number {
  const n = spectrum.length;
  const lo = Math.max(0, Math.min(n - 1, binOf(fromHz, n)));
  const hi = Math.max(lo + 1, Math.min(n, binOf(toHz, n)));
  let sum = 0;
  for (let i = lo; i < hi; i++) {
    const db = MIN_DB + (spectrum[i] / 255) * (MAX_DB - MIN_DB);
    sum += 10 ** (db / 20);
  }
  return sum / (hi - lo);
}

interface MouthFeatures {
  /** The fundamental. On a voice around 200 Hz it carries most of the energy. */
  voice: number;
  /** Low first formant — the jaw nearly shut, as in /i/ and /u/. */
  f1lo: number;
  /** High first formant — the jaw down, as in /a/. */
  f1hi: number;
  /** Second formant: where the tongue is. */
  f2: number;
  /** Fricative energy. */
  hiss: number;
}

function features(spectrum: Uint8Array): MouthFeatures {
  return {
    voice: bandPower(spectrum, 100, 250),
    f1lo: bandPower(spectrum, 250, 500),
    f1hi: bandPower(spectrum, 500, 1000),
    f2: bandPower(spectrum, 1000, 2500),
    hiss: bandPower(spectrum, 4000, 8000),
  };
}

/**
 * The shape this spectrum is articulating.
 *
 * Deliberately five outcomes and no more: the sprites draw five distinguishable
 * mouths, so a finer classifier would spend frame swaps on distinctions the
 * picture cannot show.
 *
 * The vowel rules divide by energy ABOVE the fundamental. Measured against the
 * total, the fundamental of a voice at ~200 Hz is two thirds of everything and
 * every other ratio collapses into the same narrow range — which is how the first
 * version came to answer "L" for a recording of nothing but sustained vowels. The
 * hiss rule is the exception and divides by the total on purpose: see `sibilant`.
 */
export function shapeOf(spectrum: Uint8Array): Shape {
  const { voice, f1lo, f1hi, f2, hiss } = features(spectrum);
  const artic = f1lo + f1hi + f2 + hiss + 1e-15;
  const t = SHAPE_THRESHOLDS;

  // Hiss first: a fricative is loud across the voiced bands too, so testing for it
  // after the vowel rules would read /s/ as an open mouth.
  if (hiss / (voice + artic) > t.sibilant) return "FV";
  // Nearly everything in the fundamental and little above it: lips together.
  if (artic / (voice + artic) < t.closure) return "MBP";
  if (f1hi / (f1lo + f1hi + 1e-15) > t.open) return "AI";
  if (f2 / (f1lo + f1hi + 1e-15) > t.front) return "O";
  return "L";
}
