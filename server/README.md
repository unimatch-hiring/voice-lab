# voice-lab history server

The local backend for conversation history: the page streams each ElevenLabs conversation
to it and a SQLite file keeps it. Nothing deploys it — it runs on the machine that runs the
page. Why it exists and what is recorded: [`docs/history.md`](../docs/history.md).

Needs Node 22.13 or newer (`node:sqlite` is unflagged from there). No dependencies beyond
the repository's own.

## Run

```sh
npm run server    # http://127.0.0.1:8788
npm run dev       # in another terminal: the page, http://localhost:5173
npm run test:server
```

A dev build of the page sends history to `http://localhost:8788` by itself.

## Configuration

All through environment variables; none is required.

| | default |
|---|---|
| `HOST` | `127.0.0.1` |
| `PORT` | `8788` |
| `HISTORY_DB` | `server/data/history.sqlite`; a relative path is taken from the repository root, and its directory is created on start |
| `HISTORY_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173` — comma-separated browser origins that may call the API |

A request with an `Origin` outside that list gets `403`; one with no `Origin` (`curl`) is let in.

## Endpoints

Every route needs `x-history-user`: a UUID v4, otherwise `400`. Only the SHA-256 of it is stored.

| | |
|---|---|
| `POST /conversations` | open; body `{conversationId, agentId}`. `200`; same user again `200`, another user's id `403`, a deleted id `410` |
| `POST /conversations/:id/entries` | body `{entries}`, up to 50 of `{kind:"line",seq,speaker,text,atMs}`, `{kind:"turn",seq,atMs,metrics}`, `{kind:"resume",segment}` or `{kind:"end",endedBy,segment,message?}`; `endedBy` is `user`, `agent`, `error` or `closed` (the user left the page), `segment` an integer from 1 — an unknown `endedBy` or a missing `segment` is `400`. `200`; not opened `404`, another user's `403`, deleted `410`, a limit passed `400` |
| `GET /conversations?cursor=` | `200` `{conversations, nextCursor, totals}`, 50 a page, newest first; a cursor that does not decode `400`. `totals` is `{all, completed, failed}`: `completed` is ended by `user` or `agent`, `failed` by `error`, and a `closed` ending counts in `all` only |
| `GET /conversations/:id` | `200` `{conversation, lines, turns}`; not this user's `404` |
| `DELETE /conversations/:id` | `204`; deleting again what this user already deleted `204`, so a lost answer can be retried; not this user's `404` |

Any other path is `404`, any other method on a known path `405`, a body that does not parse or
validate `400`, a body over 1 MiB `413`.

Every `conversation` in a response carries `state`, worked out on each read and never stored:
`ended` when it has an ending; otherwise `in-progress` when its last entry arrived less than
120 000 ms ago (`IN_PROGRESS_WINDOW_MS` in `store.js`), else `interrupted` — the page went away
without sending an ending. A conversation without an ending has no end time; its duration runs
to `lastEntryAt`.

### Segments

One conversation is one page visit; each Start…End stretch in it is a segment, numbered from 1.
The server keeps the number of the newest segment it has heard of and one ending, by three rules
that do not depend on arrival order, so a retried or duplicate request cannot undo a newer state:

- `resume{segment:n}` applies only when `n` is greater than the stored segment; it stores `n` and clears the ending.
- `end{segment:n}` applies only when `n` is at least the stored segment; it stores `n` and overwrites the ending, so the latest ending wins.
- The entries of one request are applied in array order.

## Where the data lives

In `HISTORY_DB`, by default `server/data/history.sqlite` (gitignored).

```sh
sqlite3 server/data/history.sqlite '.tables'
sqlite3 server/data/history.sqlite 'select id, agent_id, ended_by from conversations'
```

Starting over is stopping the server and deleting the file.

## Try it with curl

With `npm run server` running. The statuses in the comments are what each command answers.

```sh
HISTORY=http://127.0.0.1:8788
USER_ID=3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b
JSON='content-type: application/json'

# open a conversation                                   -> 200 {"id":"c-demo"}
curl -i -X POST $HISTORY/conversations -H "x-history-user: $USER_ID" -H "$JSON" \
  -d '{"conversationId":"c-demo","agentId":"a-demo"}'

# append two lines                                      -> 200 {"ok":true}
curl -i -X POST $HISTORY/conversations/c-demo/entries -H "x-history-user: $USER_ID" -H "$JSON" \
  -d '{"entries":[{"kind":"line","seq":1,"speaker":"user","text":"Hello","atMs":1200},{"kind":"line","seq":2,"speaker":"agent","text":"Hi, how can I help?","atMs":2600}]}'

# end it                                                -> 200 {"ok":true}
curl -i -X POST $HISTORY/conversations/c-demo/entries -H "x-history-user: $USER_ID" -H "$JSON" \
  -d '{"entries":[{"kind":"end","endedBy":"user","segment":1}]}'

# list                                                  -> 200, one conversation, totals.completed 1
curl -i $HISTORY/conversations -H "x-history-user: $USER_ID"

# read                                                  -> 200, the two lines
curl -i $HISTORY/conversations/c-demo -H "x-history-user: $USER_ID"

# delete                                                -> 204
curl -i -X DELETE $HISTORY/conversations/c-demo -H "x-history-user: $USER_ID"

# read it again                                         -> 404 {"error":"conversation not found"}
curl -i $HISTORY/conversations/c-demo -H "x-history-user: $USER_ID"

# open the deleted id again                             -> 410 {"error":"conversation was deleted"}
curl -i -X POST $HISTORY/conversations -H "x-history-user: $USER_ID" -H "$JSON" \
  -d '{"conversationId":"c-demo","agentId":"a-demo"}'
```

Without the `x-history-user` header every command answers `400`.
