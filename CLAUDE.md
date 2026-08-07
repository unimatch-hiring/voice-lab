# voice-lab

Interactive explainer of a voice-agent pipeline. Speak, watch each stage report the
milliseconds it actually took, and hear the reply back. Client-side SPA; the conversation
runs on [ElevenLabs Agents](https://elevenlabs.io/docs/agents-platform/overview).

## Commands

`npm ci` · `npm run dev` → http://localhost:5173 · `npm run build` · `npm test`

Type-check is part of the build (`tsc -b`).

## Layout

- `src/lib/pipeline/` — the conversation and the stage stream
- `src/lib/` — transport, config, token storage, viseme mapping
- `src/scene/` — the scene; reads events only
- `worker/` — Cloudflare Worker minting short-lived tokens
- `tools/` — sprite builder
- `docs/` — everything below

## Working here

Read the doc for the area you are touching before you touch it.

| | |
|---|---|
| [docs/conventions.md](docs/conventions.md) | how we write code here — **read first** |
| [docs/pipeline.md](docs/pipeline.md) | stage mapping, turn boundaries, why not our own pipeline |
| [docs/mouth.md](docs/mouth.md) | lip sync: amplitude source, invariants, sprites |
| [docs/deploy.md](docs/deploy.md) | Pages, Worker, secrets |

Non-negotiable, in full in [conventions](docs/conventions.md):

1. **Ship a test with every behaviour change**, and check it fails when the change is
   reverted.
2. **Comment only the non-obvious** — why, not what. One or two lines.
3. **No new runtime dependencies.**
4. **High-frequency data lives in refs**, never in state.
