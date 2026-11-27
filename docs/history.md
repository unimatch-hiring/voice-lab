# History

Every ElevenLabs conversation is kept while it happens — its lines, the metrics of each turn
and how it ended — so the visitor who held it can come back to it. A conversation is one page
visit. The page streams it to a local server in [`server/`](../server/README.md), which keeps
it in a SQLite file.

## Local only

The server is a plain Node process (`npm run server`), started next to the page
(`npm run dev`). Nothing deploys it. A dev build sends history to `http://localhost:8788`; any
build sends it to `VITE_HISTORY_URL` when that is set. The published site and previews set
neither, so they send nothing and look as they did before history existed.

The data lives in `server/data/history.sqlite` (gitignored) on whichever machine runs the
server. `sqlite3 server/data/history.sqlite` opens it.

## Whose history

The page gives each browser a random UUID v4 on first visit and keeps it in `localStorage`
(`voice-lab.historyUser`). Every conversation is stored under it, and only that id can list,
read or delete it — no interview key is involved. The id travels in the `x-history-user`
header, never in a URL, and the server stores only its SHA-256.

So the id is the only key to the history: clearing site data or another browser means a fresh,
empty history, and nothing recovers the old one. A page served over plain HTTP on a LAN address
has no `crypto.randomUUID` (it exists only in secure contexts), so it gets no id and records
nothing. A build without a history server makes no id at all.

## One conversation per page visit

The first Start on a page opens a conversation. End followed by Start on the same page does
not open another: it continues the same conversation, with the same id, and the line numbers
and times keep counting from the first Start. Each Start…End stretch is a *segment*, numbered
from 1. Reloading the page starts a new conversation.

The page sends `{kind:"resume", segment:n}` when segment `n` (2 or more) starts, and every ending
says which segment it ends. The server keeps the number of the newest segment it has heard of
and one ending, by three rules that do not depend on the order requests arrive in, so a
retried or duplicate request cannot undo something newer
([`server/README.md`](../server/README.md#segments)):

A resume applies only when its segment is newer than the stored one: it stores that segment and
clears the ending, because the conversation is running again.

An ending applies only when its segment is the stored one or newer: it stores that segment and
replaces the ending, so the latest ending wins.

The entries of one request are applied in the order they were sent.

Closing or reloading the tab is an ending too. When the page is hidden while a segment is
running, it sends `{kind:"end", endedBy:"closed"}` in a keepalive request, which the browser
finishes after the page is gone, together with any lines still waiting to be resent. A keepalive
request carries at most 50 entries and 64 KiB, so after a long outage the oldest waiting entries
go and the rest are lost; the ending always goes, since the server applies it in any order.
"Closed" means the visitor left; the history list words it as such.

A conversation that never received an ending — the keepalive request did not get through, or the
browser crashed — is still shown honestly. The server works its state out on every read: with
an ending it is "ended"; without one it is "in progress" while its last entry arrived less than
2 minutes ago, and "interrupted" after that. A conversation without an ending is measured up to
its last entry.

## What is recorded, and when

| | |
|---|---|
| when the session connects | the conversation: its ElevenLabs id, the agent id, the start time |
| each later Start on the same page | a resume with the number of the new segment; the new Start's own ElevenLabs id is not used |
| each recognised line and each complete agent reply | speaker, text, ms since the first Start |
| each completed turn | ms per stage, the turn's total, model tokens, synthesised characters |
| the end of a segment | when, which segment, and who ended it — the visitor, the agent, an error with its message, or `closed` when the tab went away |

Lines and turns are numbered from 1, separately. Every entry is sent the moment it exists, one
request at a time, and resent with the same number when the network or the server fails; the
server stores a number once. A gap in the line numbers is a line that never arrived.

A conversation keeps at most 2000 lines: the server refuses more, so the page stops sending
lines after the 2000th, while turns and the ending still go.

A line longer than 4000 characters is stored clipped to its first 4000, and an error message to
its first 500: the server refuses a request whole, and one refused request used to end the
recording of the rest of the conversation. The limits live in
[`shared/historyContract.js`](../shared/historyContract.js), which the page and the server both
read. The server also refuses a request body over 1 MiB with 413 before reading further.

Not recorded: a start that fails before connecting (microphone blocked, key rejected),
conversations on the Deepgram backup engine, audio, word timings, the persona prompt.

## What the visitor sees

One line under the start button, and only once a segment has ended: "Saving to history…", then
"Saved to history — 6:48, completed." (or "failed — <message>"), or a red "This conversation
was not saved to history" when the server refused it or entries were still unsent 15 seconds
after the end. While a segment is being recorded there is no line. "Not saved" because the
server refused is final: nothing more of that conversation is sent, even if the server comes
back a moment later, and the next Start is a new conversation. A refusal during the conversation
shows at once; the conversation itself goes on either way.

Pressing Start again after an ending does not cut the saving short and does not add a second line:
the same conversation continues, and its line comes back with the next ending, counting the
whole conversation from its first Start.

## The history page

The "history" link in the header opens `?history`: the visitor's conversations, newest first, with
the date, the time, the length and how each ended, and the totals above them. The first 50 show;
"Show older conversations" loads the next 50. A row opens `?history=<id>`, one conversation: its
outcome and length, the median turn split by stage, a table of every turn, and the transcript.
Both pages delete, after a confirmation. With the server down, both say to run `npm run server`.

## Known limits

After End with the history server down the page tries for 15 seconds, then says "not saved";
nothing is kept in the browser for later. Lines spoken while the server was down and given up on
are lost. The next Start on the same page resumes the same conversation and sends again, but
what was given up on is not sent then.

Closing the tab before the server has answered the very first open of a conversation sends
nothing, because the server refuses entries for a conversation it does not have yet. That
conversation is left without an ending and shows as interrupted. On a local server the window is
one round trip.

## Deleting

Only by its owner: from the history page, or through `DELETE /conversations/:id`. Nothing
expires a conversation. A
deleted id leaves a tombstone, so a late retry from a tab that was still open cannot bring it
back. The tombstone remembers the owner, so the owner repeating a delete whose answer was lost
gets 204 again; anyone else gets 404. To start over completely, stop the server and delete the file.

Endpoints, statuses and a `curl` walk-through: [`server/README.md`](../server/README.md).
