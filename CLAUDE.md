# voice-lab

Interactive explainer of a voice-agent pipeline. We own the presentation; the conversation
runs on [ElevenLabs Agents](https://elevenlabs.io/docs/agents-platform/overview). What the
thing is and how the directories divide up: [README](./README.md).

## Done means the checks pass

```sh
npm ci
npm test          # vitest, ~2s
npm run build     # type-check (tsc -b) is part of it
npm run dev       # http://localhost:5173
```

**Show the output of both before calling anything finished.** Neither is optional and
neither takes long enough to skip.

## The conversation cannot be run locally without a key

A live turn needs the deployed Worker and a token pasted into the page — no key, no
conversation, and nothing about the pipeline can be observed by hand. **So behaviour here is
proven by tests, not by talking to it.** `agentSession.test.ts` drives the SDK callbacks
directly; that is the fast way to check anything event-shaped.

`?bench` replays recorded speech through the mouth, and `?record` writes those fixtures.

## What the SDK actually does is documented only by the SDK

We do not own the events. Their shape and their order live in
`node_modules/@elevenlabs/client/dist` — the `.d.ts` for the shape, the `.js` for the order
things happen in. **What the docs below say about events is what we observed, not a
contract**; when the two disagree, the SDK is right and the doc is a bug.

Read the doc for the area you are touching before you touch it.

| | |
|---|---|
| [docs/conventions.md](docs/conventions.md) | how we write code here — **read first** |
| [docs/pipeline.md](docs/pipeline.md) | stage mapping, turn boundaries, why not our own pipeline |
| [docs/layers.md](docs/layers.md) | the layered loop: what runs beside a reply, and why none of it can gate one |
| [docs/mouth.md](docs/mouth.md) | lip sync: amplitude source, invariants, sprites |
| [docs/deploy.md](docs/deploy.md) | Pages, Worker, secrets |

## Non-negotiable

Full reasoning in [conventions](docs/conventions.md). YOU MUST NOT trade any of these for
a faster green run.

1. **Every behaviour change ships a test, and the test has to fail when the change is
   reverted.** Check that it does — a test green both ways is not testing the change.
2. **`src/scene/*` never imports `src/lib/pipeline/*`** — only `types.ts` and `events.ts`.
   The pipeline does not know it is being drawn. New facts reach the scene as events.
3. **High-frequency data lives in refs, never in state.** One `requestAnimationFrame` reads
   the refs and draws; zero React renders per frame.
   [`render-count.test.tsx`](src/scene/render-count.test.tsx) is the check.
4. **No new runtime dependencies** beyond React and the ElevenLabs client.
5. **Comment only the non-obvious** — why, not what, one or two lines.

## Repository etiquette

**A green CI run on `main` deploys — Pages and the Worker both.** So `main` is never pushed
to directly: branch, open a PR, let CI go green there.

Commit subjects are a plain imperative sentence saying what changed — no `feat:`/`fix:`
prefixes, no scopes. The body carries the *why*, with numbers when there are numbers.
`git log` is the house style guide.
