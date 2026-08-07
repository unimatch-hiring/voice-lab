# voice-lab — project context for AI coding agents

An interactive explainer of a voice-agent pipeline. Say a phrase, watch it flow
through the stages (`capture → vad → stt → llm → tts → playback`) with real
timings, and hear the reply spoken back. Client-side SPA, no backend of its own.

## Stack & commands

- Vite + React 19 + TypeScript (strict).
- `npm ci` — install. `npm run dev` → http://localhost:5173. `npm run build` → `dist/`.
- `npm test` — vitest. Type-check is part of the build (`tsc -b`).

## Layout

- `src/lib/pipeline/*` — pipeline stages, each behind a narrow interface.
- `src/lib/pipeline/orchestrator.ts` — runs a turn, collects metrics, emits events.
- `src/lib/transport.ts` — the only place that knows about the token-minter.
- `src/lib/visemes.ts` — character → viseme on top of the TTS `alignment`.
- `src/scene/*` — the scene. Reads the event stream only.
- `public/face/*` — character frames: `rest` plus three opening phases per viseme
  (`*q` quarter, `*h` half, no suffix — full). Built by `tools/build-face-sprites.py`
  from the generated sources; never hand-edited.
- `src/lib/fixtures/` — recorded turns for offline mode.
- `worker/` — Cloudflare Worker handing out single-use ElevenLabs tokens.

## Rules that must not be broken

**1. Never `setState` on high-frequency data.** Audio chunks, LLM tokens, animation
frames, stage progress — `useRef` only. A single `requestAnimationFrame` reads the
refs and draws. Zero React renders per frame.

What breaks otherwise: a 100 Hz event stream turns into 100 renders/s, the UI
starts to lag, and the scene stops showing honest timings — meaning the product
starts lying about the one thing it exists for. There is a test for this
(`src/scene/render-count.test.tsx`) and it will fail.

Specifically forbidden: `setState` per audio chunk or token; animating 200 SVG
nodes as React children; a live millisecond counter as React text without
throttling to ~10 Hz.

**2. Module boundaries.** `src/scene/*` does not import `src/lib/pipeline/*` (only
`types.ts` and `events.ts`). The pipeline does not know it is being drawn. Either
half can change without breaking the other.

**3. The mouth is a continuous amplitude, not frame switching.** `Mouth.tsx` drives
an opening value 0..1, damps it with inertia, and distributes it across adjacent
phases so the opacities always sum to exactly 1. Three things, each of which has
already broken the animation once:

- **No CSS `transition` on top of it.** That is a second source of time: at 10-15
  viseme changes per second the fade never finishes and frames flicker for 16 ms.
- **Do not let layers add up.** With both neighbouring frames at 100% the density
  doubles, which is visible as a jolt mid-motion.
- **Stretch the silence threshold, do not clip it.** Zeroing the amplitude at the
  threshold makes the mouth jump open on every speech onset.

Guarded by `src/scene/sprites.test.ts`, which measures the **pixels** of the
sprites. Tests over `opacity` numbers alone are useless here: they stay green on a
visibly broken animation — verified the hard way.

## Conventions

- Zero new runtime dependencies. Only react + react-dom.
- Russian STT is always `language_code=rus`. The default `eng` turns Russian speech
  into garbage.
- Offline mode on fixtures must always work — CI runs it.
