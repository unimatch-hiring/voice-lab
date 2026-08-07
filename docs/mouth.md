# Mouth

The character's mouth is nine sprites per viseme phase, cross-faded by a continuous
opening amplitude. [`Mouth.tsx`](../src/scene/Mouth.tsx) draws it;
[`build-face-sprites.py`](../tools/build-face-sprites.py) builds the frames.

## Where the amplitude comes from

The spectrum of the audio actually playing, not the alignment.

`getOutputByteFrequencyData()` does not return raw FFT bins: the SDK resamples 100–8000 Hz
linearly across 1024 slots, so bin `i` is `100 + (i / 1024) * 7900` Hz regardless of sample
rate or FFT size. Compute band edges from that, not from a bin width.

| Band | Bins | Meaning |
|---|---|---|
| 200–900 Hz | 13–104 | how far the jaw drops on a vowel |
| 3–8 kHz | 376+ | sibilants — loud, but spoken through a nearly shut mouth |

The SDK also applies its own `smoothingTimeConstant = 0.8`, so the inertia in `Mouth.tsx`
sits on top of one smoothing stage already.

Sibilant energy is subtracted from the opening. Driving the mouth from total loudness made
every `s` a wide-open mouth: the shape was loud rather than correct.

Alignment (`onAudioAlignment`) picks *which* shape. Loudness decides *how far* it opens.
Alignment alone was the "sometimes it talks and the mouth does not move" bug — it does not
arrive for every chunk and can drift from the audio, whereas loudness cannot.

## Invariants

Three of these have each broken the animation once.

- **No CSS `transition` on the layers.** That is a second clock: at 10–15 viseme changes a
  second the fade never finishes and frames flicker for 16 ms.
- **Layers must not add up.** With both neighbours at 100% the density doubles, which reads
  as a jolt mid-motion. Weights across the active layers always sum to one.
- **Stretch the silence threshold, do not clip it.** Zeroing the amplitude at the threshold
  makes the mouth jump open on every onset.
- **Silence closes the mouth.** Any formula where a viseme can hold the mouth open at zero
  loudness leaves it hanging open while the agent says nothing.

## Sprites

`rest` plus three phases per viseme: `*q` quarter, `*h` half, no suffix full. The builder
orders phases by measured openness rather than by filename — the generator does not always
hit the requested amplitude, and filename order once opened the mouth wider before snapping
it shut mid-viseme.

Outside the mouth region every frame is bit-identical, enforced by
[`sprites.test.ts`](../src/scene/sprites.test.ts). Without it the whole character shimmers
on a viseme change.
