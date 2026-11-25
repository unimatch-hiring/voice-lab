# Proposal

## Why

`conversation-history-storage` keeps every conversation on the local history server and gives
its owner endpoints to list, read and delete them, but nothing on the page uses them: the
visitor is told "Saved to history" and has nowhere to go. This change is the page that change
left out — the happy path first: get to the history, see past conversations, open one, delete
one.

## What Changes

- A link "history" in the panel header, next to "settings", wherever the page has a history
  server; the "Saved to history" line under the start button links there too.
- A history page at `?history`: the visitor's conversations newest first — date, start and end
  time, length, outcome — with the totals (all, completed, failed) in its header.
- A conversation page at `?history=<id>`: when it ran, how it ended and who ended it, its
  length and number of turns, the median turn per stage, every turn's timings, and the whole
  transcript.
- Deleting a conversation from its row in the list or from its page, each after an in-place
  confirmation.

Out of scope, next steps: a designed empty list and server-unreachable state (each is one
plain line here), "Load older" past the first 50, the failed-conversation notice on the
conversation page, a designed state for a conversation whose ending never arrived, and the
capture and playback stages.

## Capabilities

### New Capabilities
- `conversation-history-page`: how a visitor reaches their history, what the list and a
  conversation show, and how they delete one.

### Modified Capabilities
<!-- None: openspec/specs/ is empty; conversation-history-storage is not archived yet. -->

## Impact

- **Halves touched:** `src/lib` (a read client for the history server, pure formatting and
  median helpers, the route), a new `src/history/` for the two pages, `src/main.tsx`,
  `src/App.tsx` (the header link and the link in the saved line). `src/scene` gains no code;
  the pages reuse its CSS classes. No new event in `src/lib/types.ts`: the pages read stored
  data, not the pipeline.
- **Engines:** only ElevenLabs conversations are recorded, so only they appear. Nothing changes
  on the Deepgram engine.
- **Where it works:** wherever `historyUrl` is set (a dev build, or `VITE_HISTORY_URL`). The
  published site and previews have none: no link, and `?history` says history is not
  available there.
- **Depends on:** `conversation-history-storage` (its read endpoints and the browser user id).
- **Manual steps outside the repository:** none.
- **Dependencies:** none new.
- **Docs:** `docs/history.md` gains how the page is reached and what it shows.
