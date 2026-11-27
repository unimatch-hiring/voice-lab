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

## Parental control

The assistant is set up for a child, with a separate page for the parent at `?parent`
(linked from the assistant as "For parents", no access control by design).

**What the parent sets** — four free-form fields, stored on our server:

- topics the child may discuss — the agent keeps to them, answering anything else only
  briefly and only if it is harmless
- topics the child must not discuss — the agent changes the subject without explaining why
- about the child — name, age, interests, how to talk to them
- what worries you — handed to the alarm review as a hint, never to the agent

**How it reaches the conversation.** Before every start the page reads the settings and
builds the agent's prompt from them (`src/lib/parental/childPrompt.ts`), sent as an override
through `src/lib/pipeline/elevenLabsClient.ts`. ElevenLabs applies the override only when a
session opens, so a change takes effect from the next conversation. Without the settings the
conversation does not start.

**Red flags.** Every child message is reviewed by an LLM — no keyword filter in front of it:

1. When the agent has finished answering, the page sends the child's message, the three
   lines before it and the agent's answer to `POST /api/flags/review`. The conversation is
   never held up or changed; the agent answers as usual.
2. The server asks the model (OpenRouter, `typesafe/jev-router`) whether the child may be
   at risk: self-harm, abuse, neglect, violence, sexual content, bullying, other danger. The
   model judges the latest message only; the earlier lines are there to explain it, so one
   alarm does not flag every harmless line after it.
3. A concern is stored with the full message, the context, the agent's answer, a category,
   a severity and a one-line reason. A harmless message is not stored. If the review fails
   (no key, timeout, bad answer) the message is stored as "not verified": a missed risk costs
   more than a false alarm.
4. The parent page lists the flags, newest first.

**Conversation log.** Every line of the conversation, the child's and the agent's, is
written to the server (`GET /api/transcript`). Every review decision is logged to the
server's console.

**Deleting the child's data.** One button, after a confirmation, deletes the conversation
log, every flag and the "about the child" field. The topics and "what worries you" stay.

### Running it locally

```sh
cp server/.env.example server/.env   # put the OpenRouter key in
npm run server                       # http://localhost:8790, data in server/data/db.json
npm run dev                          # proxies /api to the server
npm run eval:flags                   # the alarm review against the real model, ~10 s
```

The server is local only: GitHub Pages serves static files, so on the published site the
parent page reports the server as unreachable and the conversation does not start.

| Route | |
|---|---|
| `GET` / `PUT /api/settings` | the parent's four fields |
| `POST /api/flags/review` | `{text, context[≤3], agentReply?}` → `{flagged, flag?}` |
| `GET /api/flags` | stored flags, newest first |
| `POST` / `GET /api/transcript` | the conversation log |
| `DELETE /api/child-data` | log, flags and profile |

## How it fits together

- `src/lib/parental/` — parental control on the client: prompt, review reporter, log, API
- `server/` — parental server: JSON store, service, LLM review, HTTP routes
- `src/lib/pipeline/` — the conversation and the stage stream it emits
- `src/lib/` — transport, config, token storage, the mouth's signal path
- `src/lib/persona.ts` — the default role, used only when no child prompt is passed
- `src/scene/` — the scene; reads the event stream only and knows nothing about the pipeline
- `worker/` — Cloudflare Worker minting short-lived tokens (no audio flows through it)
- `tools/` — sprite builder for the character

More detail, by area: [docs/](docs/). Working on the code: [CLAUDE.md](./CLAUDE.md).

## License

MIT.
