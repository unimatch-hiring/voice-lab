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

Calls use an interview key to get session credentials from the deployed Worker (`worker/`).
For child calls, also start the [profile server](#parent-control-server). The browser uses
the prompt from that server and submits turns for review.

With the server running, open [Parent control](http://localhost:5173/voice-lab/?parent=local-parent)
to create child profiles and assign topics. Copy the `?child=<id>` link shown on each
profile to open a child call. Profile management works without a model key.
See [how Parent control works](docs/parent-control.md).

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

### Parent control server

Use Node.js 24 and run these commands from the checkout root.

```sh
npm --prefix server ci
npm --prefix server run db:init
npm --prefix server start
```

The init command creates `server/.data/voice-lab.sqlite`. The server runs the same
initialization on startup and listens on `http://127.0.0.1:8788` by default. See the
[server README](server/README.md) for `DATABASE_PATH` and other settings.

## Looking at a branch

Push it. Every branch but `main` is published under its own path, so a change can be
looked at — and talked to — without merging:

```
git push -u origin my-branch
→ https://unimatch-screening.github.io/voice-lab-previews/branch/my-branch/
```

The link arrives on its own: as a comment on the pull request, as a deployment on the
branch, and in the run's summary. Four previews live at once, and deleting the branch
removes its own.

A pull request from a fork gets one too, at `…/voice-lab-previews/pr-<N>/`, linked from a comment
on the pull request and removed when it closes. The fork's code is built without any
write access, and a separate job on `main` publishes the result as untrusted files. How
and why that is safe: [docs/deploy.md](docs/deploy.md#fork-previews). Previews are served
from another account's Pages, so unreviewed code never shares an origin with the admin
page: [docs/deploy.md](docs/deploy.md#where-previews-live).

## How it fits together

- `src/lib/pipeline/` — the conversation and the stage stream it emits
- `src/lib/` — transport, config, token storage, the mouth's signal path
- `server/src/` — child profiles and prompts, turn reviews, and alerts
- `shared/` — the profile contract, local parent ID, and request limits shared with the server
- `src/lib/persona.ts` — demo session prompt
- `src/scene/` — the scene; reads the event stream only and knows nothing about the pipeline
- `worker/` — Cloudflare Worker minting short-lived tokens (no audio flows through it)
- `tools/` — sprite builder for the character

More detail, by area: [docs/](docs/). Working on the code: [CLAUDE.md](./CLAUDE.md).

## License

MIT.
