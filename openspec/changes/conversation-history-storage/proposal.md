# Proposal

## Why

A conversation leaves nothing behind today: the transcript and the turn metrics live in the
page and are gone when the tab closes, unless `?record` downloads them as a fixture file.
We want visitors to see the history of their own conversations, so each conversation has to
be kept in SQLite — and kept as it happens, not posted at the end, because a closed tab, a
dead socket or an agent hanging up must not cost what was already said.

## What Changes

- A new backend in `server/`: a Node process on the built-in `node:http` and `node:sqlite`,
  started on its own with `npm run server`, storing history in a SQLite file. It runs
  locally only; nothing deploys it.
- The page gives each browser a random user id (UUID v4) on first visit and keeps it. Every
  conversation is recorded under it, and only that user id can list, read or delete it.
- Every ElevenLabs conversation that connects is streamed to the server while it runs: opened
  when the session connects, each transcript line and each completed turn's metrics appended
  the moment they exist, and its ending recorded with who ended it. Attempts that never
  connect (microphone blocked, key rejected) are not recorded.
- The visitor is told after each conversation whether it was saved, and sees an error when
  it was not.
- The read side the history page will be built on: the owner's conversations newest first
  with totals (all, completed, failed), one conversation with its lines and turns, deletion.
  The history page itself is a separate change.
- Deepgram conversations are not recorded.

Out of scope: the history page and its header link; hosting the server anywhere; checking
interview keys on the server; admin access to other people's history; moving a user id
between browsers; any change to `?record` or to `worker/`.

## Capabilities

### New Capabilities
- `conversation-recording`: the visitor's user id, what is captured from a running
  conversation, when it reaches the server, how failures are retried and reported, and who
  may add to a conversation.
- `conversation-history-access`: how a visitor lists, reads and deletes their own stored
  conversations, and the shape of what they get back — the contract the history page is
  written against.

### Modified Capabilities
<!-- None: openspec/specs/ is empty. -->

## Impact

- **Halves touched:** new `server/`; new `shared/historyContract.js`, the one place the
  limits, the user id format and the stage names of the page-to-server contract are written,
  read by both sides; `src/lib` (user id, the streaming client, config);
  `src/lib/pipeline/agentSession.ts` (reports the conversation id); `src/App.tsx` (wiring and
  the saved/not-saved line under the start button). `src/scene` and `worker/` are untouched.
  The conversation id reaches the rest of the page as a new `PipelineEvent` in
  `src/lib/types.ts`.
- **Engines:** ElevenLabs only. On Deepgram nothing is sent and no saved line is shown.
- **Where history works:** a dev build talks to `http://localhost:8788` by default; any build
  talks to `VITE_HISTORY_URL` when set. The published site and previews set neither, so they
  send nothing and look exactly as today.
- **Manual steps outside the repository:** none.
- **Dependencies:** none new. Node ≥ 22.13 for unflagged `node:sqlite` (CI runs 24, local 26);
  the page uses `crypto.randomUUID()`.
- **Docs:** `server/README.md` (run, configure, `curl` walk-through), `docs/history.md`, the
  run commands in `CLAUDE.md` and `README.md`, the `server/` line in `openspec/config.yaml`.
- **Privacy:** history sits in a file on the machine running the server. A user id is the only
  key to it: clearing site data or another browser means a fresh, empty history.
