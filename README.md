# voice-lab

An interactive explainer of a voice-agent pipeline. Talk to it and watch the conversation
move through capture → VAD → STT → LLM → TTS → playback: real milliseconds per stage, how
they overlap, and a character articulating the reply from the loudness of the voice you are
hearing.

Live: https://unimatch-hiring.github.io/voice-lab/

## Running it

```sh
npm ci
npm run dev     # http://localhost:5173
```

The conversation runs on [ElevenLabs
Agents](https://elevenlabs.io/docs/agents-platform/overview), so it needs a deployed Worker
(`worker/`) to mint session tokens and a client token to reach it.

`VITE_WORKER_URL` is a repository variable and ends up in the bundle: the Worker's address
is not a secret, access is gated by its origin list and by the token. The token itself is
deliberately absent from the published build — it spends a paid quota, so baking it in would
hand that quota to every visitor.

To switch the deployed site into live mode, paste the token into the field on the page. It
is kept in IndexedDB, encrypted under a non-extractable key, so it survives a reload without
a rebuild. For local runs a build-time variable also works:

```sh
VITE_VIBE_TOKEN=<token> npm run dev
```

## Looking at a branch

Push it. Every branch but `main` is published under its own path, so a change can be
looked at — and talked to — without merging:

```
git push -u origin my-branch
→ https://unimatch-hiring.github.io/voice-lab/pr-preview/my-branch/
```

The link arrives on its own: as a comment on the pull request, as a deployment on the
branch, and in the run's summary. Four previews live at once, and deleting the branch
removes its own. Details, including why previews do not cover forks:
[docs/deploy.md](docs/deploy.md).

## How it fits together

- `src/lib/pipeline/` — the conversation and the stage stream it emits
- `src/lib/` — transport, config, token storage, the mouth's signal path
- `src/lib/persona.ts` — the agent's role, sent as an override when the session opens
- `src/scene/` — the scene; reads the event stream only and knows nothing about the pipeline
- `worker/` — Cloudflare Worker minting short-lived tokens (no audio flows through it)
- `tools/` — sprite builder for the character

More detail, by area: [docs/](docs/). Working on the code: [CLAUDE.md](./CLAUDE.md).

## License

MIT.
