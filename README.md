# voice-lab

An interactive explainer of a voice-agent pipeline. Say a phrase and watch it move
through capture → VAD → STT → LLM → TTS → playback: real milliseconds per stage,
how they overlap, and a character articulating the reply from the TTS timestamps.

Live: https://unimatch-hiring.github.io/voice-lab/

## Running it

```sh
npm ci
npm run dev     # http://localhost:5173
```

Out of the box it runs offline on recorded fixtures — the whole pipeline and the
scene work with no keys at all. The live microphone needs a deployed Worker
(`worker/`) and a client token.

`VITE_WORKER_URL` is a repository variable and ends up in the bundle: the Worker's
address is not a secret, access is gated by its origin list and by the token. The
token itself is deliberately absent from the published build — it spends a paid
quota, so baking it in would hand that quota to every visitor.

To switch the deployed site into live mode, paste the token into the field on the
page. It is kept in IndexedDB, encrypted under a non-extractable key, so it
survives a reload without a rebuild. For local runs a build-time variable also
works:

```sh
VITE_VIBE_TOKEN=<token> npm run dev
```

## How it fits together

- `src/lib/pipeline/` — pipeline stages, each behind a narrow interface.
- `src/lib/pipeline/orchestrator.ts` — runs a turn, collects metrics, emits events.
- `src/scene/` — the scene. Reads the event stream only; it knows nothing about how
  the pipeline works.
- `worker/` — Cloudflare Worker handing out single-use tokens (no audio flows
  through it).

More detail for AI agents: [CLAUDE.md](./CLAUDE.md).

## License

MIT.
