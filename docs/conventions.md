# Conventions

## Comments

Comment only what the code cannot say. If a reader can get it from the code, the comment
is noise.

Write one when the answer is not in the diff:

- why it is done this way and not the obvious way
- a non-local consequence — "changing this breaks that over there"
- an external constraint: a vendor bug, an API version, how the infra behaves

Do not write:

- a restatement of the code (`// increment counter` above `i += 1`)
- the story of an incident with dates and measurements — that belongs in the commit
- six lines of operating instructions — that belongs here in `docs/`
- the same explanation above each of three similar places — once is enough

Aim for one or two lines. Three or more is a prompt to ask whether it is a restatement, or
whether it belongs in the commit message instead.

## Tests

Every change to behaviour ships with a test in the same PR. The test has to fail when the
change is reverted — if it passes both ways it is not testing the change.

Test what the product promises, not what the implementation happens to do. Asserting on
numbers the code itself assigns produces suites that stay green while the product is
visibly broken; that has happened here, which is why
[`sprites.test.ts`](../src/scene/sprites.test.ts) measures pixels rather than opacity
values.

## Dependencies

No new runtime dependencies beyond React and the ElevenLabs client. A dev dependency needs
a reason that survives being read out loud.

## Module boundaries

`src/scene/*` does not import `src/lib/pipeline/*` — only `types.ts` and `events.ts`. The
pipeline does not know it is being drawn. Either half can change without breaking the
other.

## High-frequency data

Audio frames, tokens, animation frames and stage progress live in refs, never in state. A
single `requestAnimationFrame` reads the refs and draws. Zero React renders per frame.

A 100 Hz event stream turned into 100 renders/s makes the UI lag, and then the scene stops
showing honest timings — the product starts lying about the one thing it exists for.
[`render-count.test.tsx`](../src/scene/render-count.test.tsx) fails if this slips.
