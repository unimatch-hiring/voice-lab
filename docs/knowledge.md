# Knowledge base

What the coach may know, kept in [`knowledge/coach/`](../knowledge/coach). The page bundles
the files and searches them itself ([`knowledge.ts`](../src/lib/knowledge.ts)): after each
thing the person says, the best `##` sections, up to about 3500 characters, go to the agent
as a contextual update ([pipeline](pipeline.md#who-decides-the-role)). That needs no access
to the agent, at a cost: the update informs the turns after those words, not the reply to
them, and the ranking is BM25 over five-letter stems, which matches word forms but not
synonyms. Headings that name their subject are what make it work at all.

## Scope

In — what a coach of school and student teams needs to answer from: the rules of ЧГК,
Брейн-ринг, Своя игра, Эрудит-квартет and Даугавпилс; how answers are judged and appealed;
how a season, a session and a warm-up are built; captain, roles, seating and discussion
technique; how a ЧГК question unwinds, by type of move, and how to compose a simple one; how to run a school tournament;
where to find questions and rules.

Out, on purpose:

- **Question packs.** They belong to their authors, are often under moratorium, and an agent
  that recites answers trains nobody. `resources.md` points at the databases instead, and
  `chgk-unwinding.md` keeps what a pack teaches — the moves — without its questions. A
  question to play comes live from gotquestions.online at the start of a session
  ([worker](../worker/README.md#training-questions)); `chgk-question-recipes.md` is how the coach
  composes its own when those run out.
- **The full Codex.** Jury internals, high-level tournament procedure and place-scoring
  schemes serve organisers of championships, not a coach; the relevant chapters are
  summarised with their clause numbers.
- **TV-show history, prizes, celebrity trivia, ratings maths.** Not training.
- **Personal data from the sources** (the season plan has the coach write down each child's
  home phone and birthday) and anything about chess, poker and board games, which the
  prompt excludes.

## Markup

Each document covers one topic, and every `##` heading names its game or its subject
("Брейн-ринг: фальстарт", not "Фальстарт"): the search returns sections, not files, and a
section has to say what it is about on its own; the heading also counts double in the
ranking. The second line of each file names its sources, so the agent can say where an
answer comes from.

`manifest.json` lists each file with its sources, outside the files so it never reaches a
section. Each source carries `reuse`: `cc0` may be copied, `paraphrase` may only be
retold. [`manifest.test.js`](../knowledge/manifest.test.js) keeps the two in step.
