# The layered loop

Six layers around one conversation. Four of them never cost the speaker a millisecond, and
no failure in any of them can produce silence.

| | Reads | Emits | On the reply path | Budget | If it fails |
|---|---|---|---|---|---|
| A dialogue loop | mic audio | turn events, audio | yes | — | nothing works. `agentSession.ts`, unchanged |
| B validator | utterance, charter | `{scope, needs_recall, query}` | no | 200 ms | fails open — assume in scope |
| C archiver | transcript tail | rolling summary, pinned facts | no | 4 s | keeps the previous archive |
| D transcriber | final transcript and reply | append-only verbatim log | no | ~0 ms | it is the record; a silent drop is unrecoverable |
| E searcher | query from B | passages, or an explicit miss | only as a client tool | 600 ms | returns "not found"; never invents |
| F generator | everything above | speech | yes | — | it is ElevenLabs' own generation |

## ElevenLabs owns the turn, so B does not gate

Generation starts the moment STT settles. `onMessage({source:"user"})` is the first time this
code learns what was said, and by then the reply is already being produced — the SDK's
outgoing event set has no cancel and no mid-session prompt change.

So scope is enforced by the **persona**, which works because a narrow, opinionated character
redirects on its own. B audits the turn afterwards, tightens the next one through
`sendContextualUpdate`, and drives the `gate` lane on screen. It becomes a real gate only
behind a custom LLM endpoint, which is deferred: the model stays the one configured in the
ElevenLabs dashboard.

What this means for timing, honestly:

- **Tier 1 recall may land in time.** It is a string match over facts already in memory, so
  its contextual update goes out within a millisecond of the transcript arriving.
- **B and tier 2 will not.** They are hundreds of milliseconds behind, and they steer the
  next turn.
- **E is on the path only as a client tool.** The SDK awaits a `clientTools` handler, so the
  agent genuinely waits — but the tool has to be declared on the agent, which lives in their
  dashboard and not in this repo. `recall_from_conversation` is registered here and is simply
  never called until it is.

## Nothing may block a reply

`AgentSession` calls every layer with `void`. `LayerStack` catches inside each lane and
returns null rather than rethrowing. `validate` fails open — the verdict produced when B has
crashed maps to answering normally, not to caution.

In a chat window a dropped turn is a visible non-event. In a voice call it is
indistinguishable from the line going dead. `orchestrator.test.ts` covers the failure modes
one at a time; that suite is the point of the design.

## Memory: one lossless log, one lossy summary

D is complete and dumb, C is compact and lossy, and C is derived from D and never the
reverse. If C ever becomes the only record, the specifics are gone and the system will
confidently mis-remember.

Tier 2 narrows the verbatim log with plain lexical matching before any model reads it. That
is what replaces a vector store, and it is why the whole feature adds no runtime dependency.

## Costs measured in the proof of concept

- The parallel arrangement **only pays on turns that actually search** — one scenario in six,
  ~183 ms saved there and a tie everywhere else. Do not claim a per-turn average.
- Tier 1 answers most recall for free once C has pinned the fact. The win is narrowly about
  tier 2.
- Each layer is a separate text session on the same agent: real quota, and pooled sessions
  accumulate history, which is wrong for a stateless classifier — hence `resetAfter`.
- The recall heuristic over-fires. Markers that are also nouns (`"my budget"`) match
  statements as well as questions; each false positive is one wasted speculative call.

## Where the numbers are drawn

`gate`, `recall` and `archive` are lanes like any other, so the waterfall shows B and E
overlapping. They are listed in `OFF_PATH` and excluded from `StageBreakdown`'s total:
adding a four-second archiver to a two-second turn would report six seconds the speaker
never waited.
