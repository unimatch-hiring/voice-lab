# Mouth

The character articulates the reply from the sound actually leaving the speaker.
One opaque sprite is drawn at a time, swapped outright.

- [`Mouth.tsx`](../src/scene/Mouth.tsx) — the animation loop, and nothing else
- [`mouthShape.ts`](../src/lib/mouthShape.ts) — spectrum → which of five mouths
- [`mouthLevel.ts`](../src/lib/mouthLevel.ts) — spectrum → how far open
- [`mouthFrame.ts`](../src/lib/mouthFrame.ts) — which frame, and when it may change
- [`mouthFrames.ts`](../src/lib/mouthFrames.ts) — the sprites and the order they open in
- [`build-face-sprites.py`](../tools/build-face-sprites.py) — builds the frames

## Where the picture comes from

`getOutputByteFrequencyData()`, every animation frame. It is not raw FFT: the SDK
resamples 100–8000 Hz linearly across 1024 slots, so bin `i` is
`100 + (i / 1024) * 7900` Hz regardless of sample rate or FFT size. Compute band
edges from that, not from a bin width.

The SDK also smooths at `smoothingTimeConstant = 0.8` — a time constant near 75 ms
at 60 Hz, which is the exact scale speech articulates on. Read straight, that
signal held one frame for 300–500 ms through ordinary words. `Desmoother` takes
most of it back out (`x = (s - k·s_prev) / (1 - k)`), leaving about 25 ms. Not all
of it: undoing the full 0.8 left the mouth asking for a new frame on every tick of
the hold, which is chattering at the limiter rather than articulating.

Conditioning belongs to whoever owns the source — `agentSession.mouthSpectrum()`
and the bench — not to the animation loop. It is a filter with state that must see
every frame exactly once, and with it inside the loop the bench's own readout
described a signal nothing was using.

Loudness decides how far the mouth opens; the shape of the spectrum decides which
mouth. Neither reads a clock.

## What this replaced, and why

The mouth used to take its shape from the per-character timings the provider sends
(`onAudioAlignment`) and its moment from a wall clock started when the agent
reported it had begun speaking. That is gone. Alignment does not arrive for every
chunk, and the clock starts when a packet lands rather than when a speaker moves,
so the two drifted apart by a different amount on every run — "sometimes it
lip-syncs and sometimes it does not". A spectrum cannot drift: it is the sound
playing this frame.

The price is real and worth stating: the spectrum does not know letters. /b/ and
/d/ are one picture. The sprite set could not tell them apart either (below), so
little was actually lost — but if the character is ever redrawn with genuinely
distinct visemes, alignment becomes worth having again, anchored to playback rather
than to a wall clock.

## What the sprites can actually show

Measured, not assumed — and measuring it is less obvious than it looks.

**Openness depends on where you put the threshold.** Area darker than the closed
mouth by 25 says all eight visemes ramp cleanly; by 40 says four of them do not;
cavity depth says something else again. The sprite builder sorted phases by one of
those metrics and the old test checked the same one, so the pair agreed with
itself and a broken ramp shipped. The ladders in `mouthFrames.ts` therefore come
from a **consensus** — each frame's rank averaged over eight metrics — and
`mouthFrames.test.ts` recomputes that consensus from the pixels and fails if the
shipped table disagrees.

Two numbers worth knowing before touching any of this:

- adjacent phases of one shape differ by about as much as two different shapes do
  (median 9.4 against 13.4 mean-absolute over the mouth box);
- the eight visemes collapse into **five** groups the pixels can tell apart —
  `MBP ~ U ~ WQ`, `AI`, `E ~ O`, `FV`, `L`.

So the set draws five mouths, not twenty-four, and the runtime addresses five.
Rungs no metric separates from their neighbour (`Uh`, the full `WQ`) are dropped:
a step the eye cannot see costs a swap and shows nothing. **The ceiling on
articulation is the artwork, not the code.** Richer articulation needs the
character redrawn, not the animation retuned.

## Invariants

Each of these has broken the picture at least once.

- **Exactly one frame is opaque; opacity is only ever 0 or 1.** The previous
  version cross-faded neighbouring sprites and left the closed frame underneath at
  opacity 1 as a backdrop. On photographs that is a double exposure — ghost teeth
  over a closed muzzle — and it cannot be tuned away: with `source-over` the
  backdrop shows through by the product of what is above it, 25% at two layers of
  0.5. Measured cost: 12% of the local contrast in the mouth region.
- **No CSS `transition` on the frames.** That is a second clock competing with the
  loop.
- **The absence of a measurement is not silence, and both shut the mouth.**
  `mouthSpectrum()` returns `null` when the session is over, the socket died, or
  the SDK has started repeating itself; the animation closes on `null` linearly, so
  it reaches shut rather than approaching it. An exponential decay is always
  slightly open, and slightly open is what stays on screen.
- **The animation loop starts once and reads its source from a ref.** It used to
  depend on a callback prop that App rebuilt every render, so a finished turn
  reporting its metrics tore the loop down mid-reply and left the character frozen
  with its mouth open. `mouth-liveness.test.tsx` fails if that returns.
- **Leaving the tab is treated as the sound stopping.** A hidden tab stops rAF, so
  the loop freezes on whatever frame was up; coming back to a raccoon still holding
  a vowel it finished a minute ago is the same defect as any other stuck mouth.
- **A frame is held at least 70 ms.** Frame holding is the oldest rule in 2D lip
  sync; without it the picture changes faster than the eye resolves and reads as
  flicker. The previous 150 ms went too far the other way and dropped 54% of what
  was being said.
- **Do not travel through intermediate rungs.** These are separate poses, not
  in-betweens of a motion. Stepping one rung per frame quartered the articulation
  rate for nothing.

## Thresholds

Four in `SHAPE_THRESHOLDS`, two in `mouthFrame.ts`. Set from percentiles of the
recorded fixtures, and **in-sample**: one TTS voice, one language, mp3 rather than
the Opus a live call carries. `sibilant` is the first to move if another voice
reads every /s/ as a wide-open mouth.

`LEVEL_FLOOR` was swept against the fixtures rather than guessed. At 0.1 the mouth
is shut for 22 / 26 / 52% of the three recordings, whose written pauses are
29 / 34 / 56% — tracking them with a small deficit, which is right, because a
reverb tail is not silence. Measured in the browser on the full sentence: 7.8 frame
changes a second, median frame 65 ms, and the only holds past 400 ms fall on the
run of sustained vowels at the end, where holding is correct.

## Checking a change

`?bench` — dev only. Recorded speech replayed through the same path the live
session uses, so two runs differ only by the code between them. It shows the level,
the shape and the rate of frame changes, and has a control that cuts the signal
mid-word to prove the mouth shuts rather than freezing. Fixtures are in
`public/fixtures/`, generated with the same voice and model as the deployed agent.

Judging lip sync from an assertion is not possible — it either reads as speech or
it does not — but everything underneath it is a pure function over numbers and is
tested as one.
