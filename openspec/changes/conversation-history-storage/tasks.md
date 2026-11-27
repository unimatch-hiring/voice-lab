# Tasks

## 1. Store

- [x] 1.1 Add `server/store.js` with `ConversationStore(db)`: schema from design.md §7 created in the constructor, ops `open`, `append`, `list`, `get`, `remove`. Verify with `server/store.test.js` on an in-memory `DatabaseSync`: open is idempotent per user and refused for another user or a deleted id; append stores lines and turns once under retries, keeps order, applies the first ending only, enforces 4000 chars / 50 entries / 2000 lines all-or-nothing; list pages 50 newest-first with `nextCursor` and returns totals over the whole history (an unfinished conversation counts in `all` only); remove cascades to lines and turns and leaves a tombstone. Each test fails with its rule removed from the op; the suite passes locally and in CI on Node 24.
- [x] 1.2 Add `server/userId.js` with `isUserIdV4` and `hashUserId`. Verify with `server/userId.test.js`: a v4 UUID passes in either case, "123", a v1 UUID and an empty value fail; the hash is stable for one id and differs across ids.

## 2. HTTP

- [x] 2.1 Add `server/app.js`: `createApp(store, { allowedOrigins })` returning `(Request) => Promise<Response>` with the five routes of design.md §6, origin check, `OPTIONS` preflight, user id validation, 404 for another user's conversation on read and delete, 403 on write. Verify with `server/app.test.js` driving plain `Request` objects, one test per HTTP-facing scenario in both specs: missing and malformed user id 400, foreign origin 403, other user writes 403, other user reads and deletes 404, deleted id 410, oversized 400, totals across pages, late append after delete refused. Each fails with its check removed.
- [x] 2.2 Add `server/index.js`: env (`HOST`, `PORT`, `HISTORY_DB`, `HISTORY_ALLOWED_ORIGINS`) with the defaults of design.md §2, data directory created, `node:http` adapter between `IncomingMessage`/`ServerResponse` and the app. Add `"server"` and `"test:server"` scripts and `"engines": { "node": ">=22.13" }` to `package.json`, `server/data/` to `.gitignore`. Verify: `npm run server` starts, and the `curl` walk-through from 2.3 run against it returns the documented answers.
- [x] 2.3 Write `server/README.md`: what it is, how to run it, the environment variables, the endpoint table, and a `curl` walk-through (open, two lines, an ending, list, read, delete) with a fixed UUID. Verify: every command in it run as written against `npm run server` gives the answer it shows.

## 3. Conversation id from the pipeline

- [x] 3.1 Add `{ type: "conversation-start"; conversationId: string; agentId: string; at: number }` to `PipelineEvent` in `src/lib/types.ts`; `AgentSession` keeps the `agentId` from `agentToken()` and emits the event from `onConnect`. Verify in `src/lib/pipeline/agentSession.test.ts`: driving `onConnect({ conversationId: "c1" })` emits the event with `c1` and the agent id; it fails with the emit removed. Also assert `stop()` yields exactly one `onEnded("user")`. `deepgramSession.test.ts` asserts the Deepgram session never emits the event.
- [x] 3.2 Add the event to `docs/pipeline.md` (what opens it, the SDK version it was checked against, and that the backup engine does not emit it). Verify: the doc's description matches the test.

## 4. Page side

- [x] 4.1 Move the bus-event-to-line rule (trim, drop blanks, time since start) out of `Recorder` into one exported function in `src/lib/recorder.ts`. Verify: `recorder.test.ts` stays green unchanged, and a new test of the function fails if blank lines are let through.
- [x] 4.2 Add `src/lib/userId.ts` (`loadUserId(storage, newId)`) and `historyUrl` in `src/lib/config.ts` (`VITE_HISTORY_URL`, else localhost:8788 in a dev build, else none). Verify in `src/lib/userId.test.ts` and a config test: first call generates and stores a v4 id, second returns the same; a production config without the variable has no history address. Each fails with its rule reverted.
- [x] 4.3 Add `src/lib/history.ts` with `HistoryStream` per design.md §9. Verify in `src/lib/history.test.ts` with fake timers and a fake `fetch`: the open request goes first and lines follow in order; entries arriving before `conversation-start` are not sent; two network failures then success store each line once with the same `seq`; a 4xx stops all sending and reports `notSaved` at once; entries unacknowledged 15 s after `end` report `notSaved`; a drained queue after `end` reports `saved`; no `conversation-start` means nothing is ever sent; `end` twice sends one ending. Each fails with its rule reverted.
- [x] 4.4 Wire it in `src/App.tsx`: a `HistoryStream` per conversation start when `historyUrl` is set, `onTurn` → `addTurn`, `onEnded` → `end`, and the line under the start button (`saving`, `saved — m:ss, outcome`, not-saved error). Verify in `src/start-conversation.test.tsx`: with every history request failing the conversation still starts, runs and ends, and the not-saved error appears after 15 s; with history succeeding the saved line shows length and outcome; with no `historyUrl` no request is sent and no line shows; a start that fails on the microphone sends nothing. Each fails with its rule reverted. `render-count.test.tsx` stays green.

## 5. Docs

- [x] 5.1 Write `docs/history.md` (what is stored and when, the user id and what losing it means, ElevenLabs only, local only, where the file lives, how to delete) and add its row to the docs table in `CLAUDE.md`; add `npm run server` to the run commands in `CLAUDE.md` and `README.md`, and `server/` to "How it fits together" in `README.md` and to the halves listed in `openspec/config.yaml`. Verify: every endpoint, variable and path named in these docs exists in code.

## 6. Review fixes

- [x] 6.1 Add `shared/historyContract.js` with a `.d.ts` beside it (design.md §10) and make `server/validation.js`, `server/app.js`, `server/store.js`, `server/userId.js`, `src/lib/userId.ts` and `src/lib/history.ts` read their limits, the user id pattern and the stage names from it, with no copies left. Verify: `shared/historyContract.test.ts` fails when the contract's stage names differ from `STAGE_ORDER`, and a round-trip test that feeds the entries `HistoryStream` sends (a line, a turn with all six stages, an ending with a message) through the server's `parseEntries` fails when either side changes a field name.
- [x] 6.2 Cap the request body at 1 MiB in `server/index.js`, answering 413 before anything is parsed, and print one line naming `PORT` when the port is taken. Verify in `server/index.test.js`: a body of 1 MiB and one byte gets 413 and stores nothing, one of exactly 1 MiB is parsed; the first fails with the cap removed.
- [x] 6.3 In the store, decide access once (gone / not-found / forbidden / ok) and answer every operation as `{ status, … }`; move the cursor's encoding into the store; keep the owner's hash in the tombstone so a repeated delete by the owner answers 204; `app.js` maps statuses to HTTP in one table and takes `json(body, status)` like `worker/`. Verify: "Delete repeated after a lost answer" and "Conversation full of lines" in `server/app.test.js`, each failing with its rule reverted; every existing `server/` test stays green.
- [x] 6.4 Rework `HistoryStream` to one state union with `disposed` (design.md §9): `end()` cancels a waiting retry, a request unanswered after 10 s is retried, over-long text and end messages are clipped, the page-hide flush stays under 64 KiB, and status goes out through `onStatus`. Verify in `src/lib/history.test.ts`, each failing with its rule reverted: "Server comes back just before the end", "Server accepts the request but never answers", "Very long agent reply", "Very long error message", a flush of 50 long entries sends a body under 64 KiB, and `dispose()` while open or draining sends nothing more.
- [x] 6.5 Add `src/lib/historySaver.ts` and move the stream lifecycle out of `src/App.tsx` (design.md §9); `App` renders the saver's list of save lines. Verify in `src/start-conversation.test.tsx`: "New conversation while the last one is still saving" (the first conversation's ending is still sent and its line still appears), "Published site" at App level (no `VITE_HISTORY_URL`, production env: no request, no line), and unmounting mid-conversation still queues the ending; each fails with its rule reverted. `render-count.test.tsx` stays green.
- [x] 6.6 Drop a trailing slash from `VITE_HISTORY_URL` in `src/lib/config.ts` and set `server.strictPort` in `vite.config.ts`. Verify in `src/lib/config.test.ts`: `http://host:8788/` gives `http://host:8788`; fails with the strip removed.
- [x] 6.7 Update `docs/history.md` and `server/README.md`: clipped lines, 413, the repeated delete, what "not saved" means after 15 s, a new conversation while the last one is saving. Verify: every limit and status named there exists in `shared/historyContract.js` or `server/`.

## 7. Integration

- [x] 7.1 Run `npm test` and `npm run build`, capturing each exit code as its own step, and show both outputs. Verify: both exit 0 and the test count is above the 228 before this change.
- [ ] 7.2 Run `npm run server` and `npm run dev` together, hold one conversation with a key, and confirm with `sqlite3 server/data/history.sqlite` that its lines, turns and ending are stored and the page showed the saved line. Verify: the query output and the line are shown in the report.
- [ ] 7.3 Open a pull request and confirm CI is green, including `server/` tests on Node 24. Verify: `gh pr checks` shows every check passing.

## Workflow follow-up

- Archive the change once every scenario has a passing test and `docs/history.md` describes the shipped behaviour.
