# Design

## Context

See proposal.md for why. What the code has today:

- `Recorder` (`src/lib/recorder.ts`) already derives lines from the bus — `stt-result` for the
  visitor, `agent-reply` for the agent, trimmed, blanks dropped, time since start — and takes
  turns through `addTurn`, because `turn-end` is declared in `PipelineEvent` but nothing emits
  it. It runs only under `?record` and downloads a file.
- Nothing on the page knows the provider's conversation id. `@elevenlabs/client` 1.17.0
  (`package-lock.json`) passes it to `onConnect({ conversationId })` (`dist/types.d.ts`,
  `Callbacks`). `VoiceConversation.js` calls `onConnect` as the last step of `startSession`,
  after `markConnected()`, so a start that fails earlier (microphone, token) never reaches it.
- Ending, checked in `dist/BaseConversation.js`: `endSession()` is
  `endSessionWithDetails({ reason: "user" })`, which fires `onDisconnect` once while the
  status is `connected` or `connecting`. The stop button therefore reaches
  `onEnded("user")` through `AgentSession`'s `onDisconnect` with no call of its own.
- `transport.agentToken()` already returns `{ token, agentId }`; `AgentSession` uses only the
  token.
- `node:sqlite`, checked against <https://nodejs.org/docs/latest-v24.x/api/sqlite.html>:
  unflagged since v22.13.0, release candidate since v24.15.0. `new DatabaseSync(path)`,
  `db.exec(sql)`, `db.prepare(sql)` → `.run(...)`, `.get(...)`, `.all(...)`; all synchronous.
- `crypto.randomUUID()` returns a v4 UUID and exists only in secure contexts (MDN).
  `http://localhost` counts as one.

## Goals / Non-Goals

**Goals:**
- The history backend is its own folder and its own process: `server/`, started with
  `npm run server`, usable with `curl` and no page, no dependency beyond Node itself.
- Lines and turns reach SQLite within one request of being produced, in order, exactly once.
- The conversation and the scene behave identically with history up, down or refused; only
  the saved/not-saved line under the start button differs.

**Non-Goals:**
- Hosting the server, or history on the published site and previews.
- Checking interview keys: the server knows nothing about them.
- Proving a transcript is genuine: what is stored is what the page reported.
- Recording Deepgram conversations, word timings, audio, or the persona prompt.
- The history page, its header link and a client for the read endpoints — they ship with the
  history UI change.

## Decisions

### 1. `server/` is a plain Node process

```
server/
  index.js        entry: reads env, opens the database, starts node:http
  app.js          createApp(store, { allowedOrigins }) → (Request) => Promise<Response>
  store.js        ConversationStore(db): schema + open/append/list/get/remove
  userId.js       isUserIdV4(value), hashUserId(value)
  *.test.js       vitest
  README.md       run, configure, curl walk-through
  data/           the SQLite file (gitignored)
```

- *Over a Cloudflare Worker:* it would run locally under `wrangler dev`, but the answer was
  local only, a file one can open with `sqlite3`, and no tie to Cloudflare.
- *IO at the edge:* `app.js` takes a web-standard `Request` and returns a `Response` (both
  global in Node), and `store.js` takes an open `DatabaseSync`. So the routes are tested with
  plain `Request` objects and an in-memory database, no port; `index.js` is the only file
  that touches the network, the filesystem and the environment, adapting
  `IncomingMessage` → `Request` and `Response` → `ServerResponse` in a few lines.
- *Over Express/Fastify:* five routes do not justify a dependency.
- JavaScript, like `worker/`, so it runs with `node` and needs no build step.

### 2. Running it

- `npm run server` → `node server/index.js`. Configuration through environment variables
  with defaults: `HOST` (`127.0.0.1`), `PORT` (8788), `HISTORY_DB` (`server/data/history.sqlite`, directory
  created on start), `HISTORY_ALLOWED_ORIGINS` (`http://localhost:5173,
  http://127.0.0.1:5173, http://localhost:4173, http://127.0.0.1:4173`).
- `npm run test:server` → `vitest run server`; `npm test` collects `server/` too.
- `package.json` gains `"engines": { "node": ">=22.13" }` for unflagged `node:sqlite`.
- `server/README.md` carries a `curl` walk-through with a fixed UUID: open, append two lines
  and an ending, list, read, delete.

### 3. Where the page sends history

`loadConfig` gains `historyUrl`: `VITE_HISTORY_URL` when set, else `http://localhost:8788`
in a development build (`import.meta.env.DEV`), else none. A trailing slash is dropped, so
`http://host:8788/` does not turn every path into `//conversations`. No address → no `HistoryStream`,
no saved line: the published site and previews behave exactly as today. Locally
`npm run server` and `npm run dev` side by side is all it takes. The token still comes from
the deployed token minter.

The dev server is pinned to :5173 (`strictPort`). The server refuses a foreign origin with a
403 that carries no CORS headers, which the browser reports as a network error, so the page
cannot tell it from a server that is down. Without the pin a busy :5173 moved Vite to :5174
and every conversation ended "not saved" while the server was running.

### 4. The user id

- `src/lib/userId.ts`: `loadUserId(storage, newId)` returns the stored id or makes one with
  `crypto.randomUUID()` and stores it, in `localStorage` under `voice-lab.historyUser`. Both
  are parameters so tests pass doubles.
- *Over IndexedDB like the token:* the token is encrypted because it spends a paid quota. The
  user id guards only its own history on a local server.
- It travels in an `x-history-user` header, never in a URL. The server validates it as v4
  (the pattern in `shared/historyContract.js` that the page checks too, case-insensitive,
  lower-cased) and stores only its SHA-256, so the database file does not hold working ids.
- Another user's conversation answers 404 on reads and deletes (its existence is not
  revealed) and 403 on writes (the page must stop sending).
- A page opened over plain HTTP on a LAN address is not a secure context and has no
  `randomUUID`; it gets no user id and records nothing.

### 5. The stream is small POSTs, not a WebSocket

An ordered queue of POSTs with one in flight gives order, retry and resume for free; a socket
needs its own reconnect and resume, and `node:http` has no WebSocket server without a
dependency. "Stream" means *as it happens*, which this delivers.

### 6. Endpoints (`server/app.js`)

Every route: `Origin` in the allowed list or absent (`curl`) — else 403; `OPTIONS` answers
the preflight; `x-history-user` valid — else 400. The `node:http` adapter reads at most
1 MiB of body and answers 413 past it, before anything is parsed: the origin check needs the
whole request, so without the cap any web page could make the server buffer a body of any
size. The largest legitimate body is 50 lines of 4000 characters, about 600 KB.

| | |
|---|---|
| `POST /conversations` | open; `{conversationId, agentId}`. Same user again → 200, other user 403, deleted id 410 |
| `POST /conversations/:id/entries` | `{entries}`; each `{kind:"line",seq,speaker,text,atMs}`, `{kind:"turn",seq,atMs,metrics}` or `{kind:"end",endedBy,message?}`. Not opened 404, other user 403, deleted 410, limits 400 |
| `GET /conversations?cursor=` | `{conversations, nextCursor, totals: {all, completed, failed}}`, 50 a page, newest first |
| `GET /conversations/:id` | `{conversation, lines, turns}`; not this user's → 404 |
| `DELETE /conversations/:id` | 204; already deleted by this user → 204 again, so a delete whose answer was lost can be retried; not this user's → 404 |

The cursor is opaque (last row's `started_at` and `id`, base64), so the order can change
without breaking the history page; a cursor that does not decode is 400. The store owns the
order, so the store also encodes and decodes the cursor; `app.js` passes the string through.

Whether a user may touch a conversation is decided once, in the store: tombstoned → `gone`,
absent → `not-found`, another user's → `forbidden`, else `ok`. Every store operation answers
`{ status, … }` with that status, and `app.js` turns statuses into HTTP codes in one table
(reads and deletes show `forbidden` as 404, writes as 403).

Entry shape is checked before the transaction: `conversationId` and `agentId` strings of
1–200 characters, `seq` an integer ≥ 1, `speaker` `user|agent`, `text` 1–4000 characters,
`atMs` ≥ 0, `endedBy` `user|agent|error`, `message` ≤ 500 characters. Every number here comes
from `shared/historyContract.js` (§10).

### 7. Schema

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,      -- ElevenLabs conversation id
  user_hash     TEXT NOT NULL,         -- sha256 of the visitor's user id
  agent_id      TEXT NOT NULL,
  started_at    INTEGER NOT NULL,      -- server ms
  last_entry_at INTEGER NOT NULL,
  ended_at      INTEGER,
  ended_by      TEXT,                  -- 'user' | 'agent' | 'error'
  end_message   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS conversations_by_user
  ON conversations (user_hash, started_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS lines (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL,
  at_ms INTEGER NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
) STRICT;
CREATE TABLE IF NOT EXISTS turns (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, at_ms INTEGER NOT NULL,
  capture_ms REAL, vad_ms REAL, stt_ms REAL, llm_ms REAL, tts_ms REAL, playback_ms REAL,
  total_ms REAL NOT NULL, llm_tokens INTEGER NOT NULL, tts_chars INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
) STRICT;
CREATE TABLE IF NOT EXISTS deleted_conversations (
  id TEXT PRIMARY KEY, user_hash TEXT NOT NULL, deleted_at INTEGER NOT NULL
) STRICT;
```

- Foreign keys are on by default in `DatabaseSync`, so deleting a conversation removes its
  lines and turns by cascade.
- Totals are one query over the user's rows: `count(*)`,
  `sum(ended_by IN ('user','agent'))`, `sum(ended_by = 'error')`. A conversation without an
  ending counts in `all` only.
- Stage durations are columns, not JSON: `StageName` is a closed union of six.
- Lines and turns are numbered separately from 1, so a gap in `lines.seq` is a lost line.
- `INSERT OR IGNORE` on the primary key makes retries harmless; the ending is
  `UPDATE … WHERE ended_at IS NULL`, so the first one wins.
- `deleted_conversations` is the tombstone that stops a late retry re-creating a deleted
  conversation. It holds the id and the owner's hash, so the owner deleting again gets 204
  and anyone else still gets 404.
- The store turns on `journal_mode = WAL` and a 2 s `busy_timeout`: `docs/history.md` invites
  opening the file with `sqlite3`, and in the default journal a reader's lock makes every
  `COMMIT` fail.
- At most 2000 lines per conversation: a delivery whose lines would take it past 2000 is
  refused whole. Turns and the ending of a full conversation are still accepted, so it can
  still be closed.
- An append runs in `BEGIN … COMMIT` (`ROLLBACK` on any error): limits checked, rows inserted,
  `last_entry_at` bumped, or nothing. Node runs one request's synchronous SQL to completion,
  so no two appends interleave.

### 8. The conversation id reaches the page as an event

`AgentSession` keeps the `agentId` from `agentToken()`, subscribes to `onConnect`, and emits
`{ type: "conversation-start"; conversationId: string; agentId: string; at: number }`. No
engine field: only `AgentSession` emits it, and keeping `Engine` out of `types.ts` keeps
pipeline types out of the scene. `DeepgramSession` never emits it, which keeps Deepgram out;
a start that fails before connecting never emits it, which keeps failed attempts out.

### 9. Page side

- `src/lib/recorder.ts`: the event-to-line rule moves into one exported function used by
  `Recorder` and `HistoryStream`, so the fixture and the history cannot disagree.
- `src/lib/history.ts`, `HistoryStream`, one per started conversation; `fetch`, the server
  address, the user id and a clock are constructor parameters. One state union, one
  transition function. What the single request slot is doing (idle, a request in flight, a
  retry waiting) is a field of `open` and `draining` only, so a finished or disposed stream
  has nothing left that could send:

  ```
  idle           → open(id)   on conversation-start (nothing is queued before it: the SDK
                              fires onConnect before any message, so there is nothing to buffer)
  open           → draining   on end(reason)
  draining       → saved      when the queue is empty
  draining       → notSaved   15 s after end with entries still unacknowledged
  open, draining → notSaved   on any 4xx (stop sending, drop the queue)
  any            → disposed   on dispose() (stop sending, report nothing)
  ```

  Network errors, 5xx and a request with no answer after 10 s retry the head of the queue with
  the same `seq`, backoff doubling from 1 s and capped at 30 s. The 10 s limit uses an
  `AbortController` and the stream's own timer, so fake timers drive it in tests. `end()`
  cancels a waiting retry and sends at once with the backoff reset (a request still in
  flight keeps going, but its retry starts the backoff over): the retry can be up to
  30 s away, longer than the 15 s the ending has, so without this a server that came back
  just before the end was never tried again.
- Lines longer than the server takes are clipped where they are queued: text to 4000
  characters, the error message of an ending to 500 (§10). The server refuses a delivery
  whole and a 4xx stops the stream, so one long reply used to cost every line after it.
  Clipping, not splitting, keeps one line per utterance and its `seq`. For the same reason the
  page stops queuing lines after the 2000th; turns and the ending still go, so a three-hour
  conversation is stored with its first 2000 lines and its ending.
- On `pagehide` the queue is flushed once with `keepalive`, as many entries from its head as
  fit a 64 KiB body (the browser's keepalive cap; a larger one is rejected whole). The cap is
  per document, summed over keepalive requests in flight (Fetch spec, unverified in browsers),
  so when two streams flush, the current one goes first and the previous one gets what is left. Unverified
  whether a keepalive request with a CORS preflight is delivered on unload; everything sent
  earlier is stored already.
- The stream reports through one callback, `onStatus`: `saving` when `end()` starts draining,
  then `saved(summary)` or `notSaved(reason)`, at most once each. The reason is `refused` for a
  4xx and `unreachable` for the 15 s timeout, so the page does not tell the visitor to start a
  server that just answered. A stream that never opened reports
  nothing.
- `src/lib/historySaver.ts`, `HistorySaver`, owns the streams of one page so `App` does not:
  `start()` makes a stream for a new conversation when there is a history address and a user
  id; `addTurn` and `end` go to the current one; `flushOnPageHide` flushes every stream still
  sending; `dispose` on unmount. A new start leaves a previous stream that is still `draining`
  running to its outcome instead of disposing it, and drops it once settled. It reports one
  list of save lines through one callback, one per conversation the visitor should hear about:
  the current conversation's line, and before it the previous conversation's while it is still
  saving and after it settles, until the next start. `App` holds that list in one piece of
  state and renders it under the start button; at most a few renders per conversation, none
  per frame, and `render-count.test.tsx` keeps covering the per-frame rule. Length is
  `end − conversation-start` on the page's clock; outcome is `completed` for `user`/`agent`,
  `failed — <message>` for `error`.
- Wiring in `App`: `onTurn` → `addTurn`, `onEnded` → `end`. The stop button needs nothing
  extra (Context). On unmount the session is stopped before the saver is flushed, so the
  ending is queued first.

### 10. One owner for the page-to-server contract

`shared/historyContract.js` holds what both sides must agree on: the id length (200), entries
per request (50), line length (4000), end message length (500), lines per conversation
(2000), the user id pattern and the stage names. It is plain JavaScript so Node runs it as it
is; the page reads it through a `.d.ts` beside it. Before this the numbers were copied by
hand into up to three files on both sides, and the page did not know the two limits that
refuse a delivery.

The stage list belongs to the pipeline (`STAGE_ORDER` in `src/lib/types.ts`). The server
cannot import TypeScript, so the contract restates it and a test fails when the two differ.
A second test runs the entries the page's stream actually sends through the server's parser.

## Risks / Trade-offs

- [History lives on whichever machine runs the server] → Stated in `server/README.md` and
  `docs/history.md`; hosting is a later change.
- [Clearing site data loses access to one's history] → Stated in `docs/history.md`;
  recovering it is out of scope.
- [Anyone who reaches the port can write history under a user id they invent] → Only into
  that id's own history; the server binds to `127.0.0.1` by default
  (`HOST` overrides it).
- [`node:sqlite` is a release candidate, not stable] → Its API is used in one file,
  `store.js`; CI pins Node 24 and the tests exercise every query.
- [`keepalive` on unload unverified] → At worst the tail and the ending are lost; the
  conversation stays with what arrived.
- [A clipped line loses its end] → Only past 4000 characters (several minutes of
  uninterrupted speech); the alternative was losing the rest of the conversation.
- [Nothing is retried after the 15 s window] → The page says "not saved" and means it: the
  queue is dropped, so a server that comes back at 16 s gets nothing more. Retrying until the
  tab closes would contradict a message the visitor has already been shown.

## Migration Plan

Nothing deploys. To roll back, revert the change: the page stops sending, and the SQLite file
under `server/data/` can be deleted by hand.
