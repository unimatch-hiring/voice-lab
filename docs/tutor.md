# Tutor

The agent is an English tutor. The lesson is held in two places, and the split is the
whole design: the **prompt** carries the manner, and `src/lib/tutor/` carries whatever
must be true whether or not a model felt like following seven instructions at once.

- [`persona.ts`](../src/lib/persona.ts) — the role, sent once in the handshake
- [`language.ts`](../src/lib/tutor/language.ts) — which language the learner just spoke
- [`lesson.ts`](../src/lib/tutor/lesson.ts) — the pure reducer: state in, directives out
- [`level.ts`](../src/lib/tutor/level.ts) — what they say their level is, or sound like
- [`mistakes.ts`](../src/lib/tutor/mistakes.ts) — the rule table, and what it cannot see
- [`lessonStore.ts`](../src/lib/tutor/lessonStore.ts) — what survives a reload
- [`supervisor.ts`](../src/lib/tutor/supervisor.ts) — the only impure part, bus to channel
- [`MistakeBoard.tsx`](../src/scene/MistakeBoard.tsx) — the record, on screen

## How the tutor reaches a conversation already running

The role applies once, at session start ([pipeline](pipeline.md)), so nothing about it
can be changed mid-lesson. What can is `sendContextualUpdate()`: context the agent acts
on, which is neither a turn it answers nor a line it reads out. Every decision the
reducer makes leaves as one of those, marked `[TUTOR DIRECTIVE]` — the marker is what
the prompt keys on to keep it unspoken.

**A directive lands one turn late, or very nearly.** `stt-result` is emitted in the same
tick that opens the `llm` lane — recognition finishing is what tells us the model has
started — so the update is published while the reply to that very sentence is already
being generated. Whether it reaches the current turn or the next one is the server's
race, not ours, and there is no earlier signal to use: the language of a sentence is not
knowable before the sentence has been recognised. So the first nudge is normally heard
in the reply *after* the slip. The ladder is built for that — the first rung is an
invitation, not a reprimand — but a rung never means "this was said about this
sentence".

**Delivery is only half observable.** `sendContext` reports whether there was a live
conversation to hand the update to; past that the SDK drops a message with a console
warning of its own when the room is mid-reconnect, and nothing acknowledges one that
arrives. The rung is therefore counted in directives *handed over*, not in Russian
sentences: a nudge that never left the page is a rung the learner never heard, and
climbing past it would state the rule to somebody who was never invited back.

## Holding the lesson in English

The product's first promise, so it is not left to the prompt alone. `lesson.ts` counts
consecutive Russian utterances and escalates: an invitation back, then the rule stated,
then an offer to stop. The third slip is deliberately given another chance at rung 2
rather than escalated — asking twice is a nudge, asking every time is nagging.

**The ladder stops at offering.** Nothing in here ends a conversation; the learner does.
The agent cannot hang up either — that needs ElevenLabs' end-call tool, which lives on
the agent and is not configured.

Two numbers are the whole policy (`FIRM_AT`, `OFFER_AT`). They are chosen, not measured:
no recording of a learner drifting mid-lesson exists yet.

## The level

Asked, re-asked once, and then stopped being asked. `levelPhase` runs
`asking → asked-again → probing → set`, and "they did not answer" is decided here rather
than guessed by the agent: anything judgeable that was not a level counts as a dodge, and
two of those is enough to stop asking and start listening.

**An answer counts in either language.** Being asked your level in a language you are
still learning is the one moment where reaching for Russian is an answer rather than
drift, so `parseLevel` reads both and the steering sits that utterance out.

**A guess says it is a guess.** Three outcomes only — A2, B1, C1 — because three spoken
sentences do not support a finer number, and the agent is told to say "around B1". What
it measures: how much the learner says, how varied it is, whether clauses hang off each
other, how many ways of placing an action in time appear, and how often a rule caught a
mistake. Thresholds are reasoned, not fitted; there is no corpus of graded learners here,
and `?record` fixtures of real lessons are what would replace them.

**Russian is never evidence of English**, so a Russian sentence is not kept as a probe —
and while the learner is in Russian the level question waits where it is. Advancing it
there would either skip a re-ask nobody heard or pile two directives, come back to English
and also what is your level, into one reply. One problem at a time.

**Reset means asked again.** `resetLevel()` clears the level and returns the phase to
`asking`, tells the agent at once so the button does something mid-lesson, and keeps the
mistakes — the learner asked to be re-assessed, not to be forgotten.

## The two controls, and why each tells the agent

`Reset level` and `Clear` are mirrors: one forgets the level and keeps the record, the
other forgets the record and keeps the level. Both write through to the store, and both
send a directive at once rather than waiting for the next session, because a button that
does nothing until you reload is a button that looks broken.

The directive is not a formality. The notes are already in the agent's context and cannot
be taken back out, so without one the learner clears the board and is then told they keep
making a mistake that is no longer written anywhere.

Clearing also drops `rechecked`: those marks say which rules have been drilled, and a
learner starting a clean record who then repeats a mistake three times should be tested on
it again rather than silently passed over. Clearing an empty record does nothing at all —
no directive, no event.

One React note, since it cost an hour: the board keeps its lines and its count in the DOM,
but whether there is *anything* to clear has to be state. React will not deliver a click
to a button its own props call disabled, however the DOM flag was set, so a ref-toggled
`disabled` produced a button that looked pressable and was dead. That state changes at
most twice a lesson, which is a crossing rather than the stream.

## What survives a reload

`lessonStore.ts` keeps the level and the mistake log in their own IndexedDB database —
its own rather than a key in `tokenStore`'s, which holds secrets under a non-extractable
key and would mean two modules racing to create one object store for opposite reasons.

Nothing there is load-bearing: a private window refuses to open a database at all, so
every path degrades to "no memory yet". A tutor that forgets is worse than one that never
remembered, and a page that will not load is worse than both.

A restored lesson replays its mistakes onto the bus, so the board is not empty while the
record behind it is not, and the count continues rather than restarting at one.

## Remembering what the learner gets wrong

The agent corrects out loud and does it far better than a regular expression ever will:
it hears register, idiom and what the learner meant. But nothing keeps a model's
correction, so it cannot be counted, listed, or asked about an hour later — and
remembering is what the product promises. `mistakes.ts` is the half that can be kept.

So there are two correctors and they are not in competition. The agent teaches; the rule
table keeps the receipt.

**One sentence, not one fragment per rule.** "i like listen radio" trips two rules, and
a learner needs the sentence they should have said, so the rules apply cumulatively and
the ids are kept alongside for the per-rule count. That is also the form the board shows:
`what was said -> what English wants`.

**The log outlives a conversation.** `forgiveSteering()` is what a new lesson does:
the Russian streak is forgiven, the mistakes are not forgotten. `rollback()` is built
per action for the same reason — a dropped directive must not drop a mistake, since
the log is the one thing here a learner asks about later.

**The agent is handed each note as it happens**, so "what do I keep getting wrong?" needs
no intent detection at all: the record is simply always in context to answer from. After
the same rule fires `RECHECK_AT` times the agent is additionally asked to work a question
into its next reply that needs the right form — once per rule, because being drilled on
everything is the correcting equivalent of nagging.

**What the table cannot do**, stated so nobody mistakes the list for the whole picture:
it cannot catch "that is not how anyone says it"; it cannot tell a learner's slip from an
ASR error, since a transcript reading "I am agree" may be either; and it only handles
pronoun subjects, because "my brother have" needs to know that "brother" is singular. A
rule firing on a sentence that was fine is worse than a rule that misses — it teaches
something false — which is why `mistakes.test.ts` keeps a list of correct sentences that
must come back clean.

A second LLM pass would do better, and `findMistakes` is the seam for it: same
signature, same `Correction`, nothing else changes.

## Why the agent is left multilingual

`overrides.agent.language` would force English, and it is tempting. It also locks ASR to
English, and then a Russian sentence comes back as mangled Latin instead of Cyrillic —
the drift this code exists to notice would become invisible, with nothing in the
transcript to see it by. The agent answers in English because the prompt says so.

The page cannot control the dashboard's first message, and it does not use the optional
`firstMessage` override. Instead, once the live session is open it sends an explicit level
directive. That means a dashboard greeting may still come first, but the agent is immediately
told to ask the level before it starts assessing the learner. A learner with a saved level
does not receive that directive; their level is appended to the prompt override in the
handshake and the conversation continues at that level.

## What counts as speaking Russian

Counted in words, not characters. By character share, "yesterday I cooked борщ for my
family" is 40% Cyrillic and lands in the same bucket as a sentence that is actually
Russian — and the two call for opposite responses: supply the English word, or steer the
lesson back.

So `mixed` is inert: it neither escalates the ladder nor clears it. `unknown` — an empty
transcript, "123", "..." — is not silence passing for English, which would quietly
forgive a streak the learner never broke.

## Checking a change

`npm test`. The reducer is a pure function over strings, and the supervisor is tested
against a real `EventBus` with a recording channel, so a whole lesson — drift, steering,
return, relapse — runs in milliseconds without a token or a microphone.

One of those tests is not of a pure function:
[`tutor-wiring.test.tsx`](../src/tutor-wiring.test.tsx) drives the chain through the real
`App`, because every pure-function test here stayed green when the single line that
subscribes the tutor was deleted.

What tests cannot tell you is whether the tutor is any good to talk to: whether it
corrects without nagging, and whether it is dull. That needs a conversation.
