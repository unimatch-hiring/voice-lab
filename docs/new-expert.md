# Rolling out a new expert

What adding an expert like the quiz coach takes today, what to build so the next one takes
a day rather than a week, and what only the ElevenLabs workspace admins can change.

## What an expert is

One theme in the settings dropdown, made of four parts:

| Part | Where | Needs an admin |
|---|---|---|
| Role: prompt, model, language, recogniser hints | [`persona.ts`](../src/lib/persona.ts) — `THEMES`, `roleFor` | overrides allowed on `AGENT_ID` |
| Knowledge | `knowledge/coach/*.md` and `manifest.json`, searched by `src/lib/knowledge.ts` | no |
| Live material drawn at start, optional | a Worker route like `/questions` (`worker/questions.js`, `src/lib/trainingQuestion.ts`) | no |
| Tests | `persona.test.ts`, `knowledge.test.ts`, `token-gate.test.tsx` | no |

## What the coach taught us

- **The page can override only part of the agent.** The SDK sends the prompt with its LLM,
  the first message, the language, the TTS voice with speed, stability and similarity, ASR
  keywords and text-only mode (`overrides` in
  `node_modules/@elevenlabs/client/dist/utils/BaseConnection.d.ts`). Tools, the knowledge
  base, RAG limits and temperature stay on the agent. Each override has to be allowed
  there; a forbidden prompt, LLM or language drops the call with no error about it.
- **A client tool is found by name among the tools defined on the agent**, so the page
  cannot add one alone. The coach's `find_training_question` was built and then removed
  for that reason; its questions now arrive in the prompt at start.
- **Knowledge on the agent needs the account key**, so the page searches its own copy and
  sends sections as a contextual update. That update lands after the reply has started, so
  it informs the next turn, not this one, and the base ships in the bundle: the coach's
  took the page from 206 to 237 KB gzipped.
- **A model not given the facts invents them.** Before it had real questions, the coach
  composed ЧГК questions on false facts. Every expert needs the rule that facts come only
  from its material, and a real source for anything it is asked to produce.
- **The deployed Worker changes only with a green `main`**, so a new route is tried with
  `npm run dev:local`, which proxies it to a local Worker ([deploy](deploy.md)).
- **The Deepgram backup listens in English only**, so an expert in another language does
  not work on a key switched to it.

## Roadmap

### 1. One definition per expert, with its tests for free

The coach is wired by hand: its theme in `THEMES`, its branch in `roleFor`,
`coachKnowledge` in `App.tsx`, its folder in `manifest.test.js`. Replace that with a
registry, `src/lib/experts/<id>.ts`, each file exporting the label, audiences, prompt
builder, LLM, language, ASR keywords, its knowledge folder and, optionally, what to draw at
start. `THEMES`, `roleFor` and the knowledge search are derived from it.

- Load each expert's knowledge with a lazy `import.meta.glob`, so an expert costs the
  bundle nothing until its theme is picked.
- One contract test runs over every registered expert: a `# Guardrails` section that
  refuses other subjects, example replies that do not end on a question, at most 50 ASR
  keywords, every knowledge file listed in a manifest with dated sources.
- Each expert ships a retrieval sample — a dozen questions a real user would ask, each
  with the section that must come first — checked the way `knowledge.test.ts` checks the
  coach today.

Done when a theme added without its contract fails CI.

### 2. A scaffold

`npm run new-expert <id>` writes the expert file with the prompt sections in place, a
knowledge folder with a template document and manifest, and an empty retrieval sample.
No dependencies; it only saves copying the coach by hand.

### 3. Content, the long part

What made the coach's base work, as a checklist:

1. Write the in and out lists before any document (`docs/knowledge.md` has the
   coach's).
2. Prefer primary texts, then methodology by known practitioners, then secondary
   descriptions. Record each source's URL, date and whether it may be copied (`cc0`) or
   only retold (`paraphrase`).
3. One topic per file; every `##` heading names its subject, since a section is what the
   search returns.
4. No third-party question or answer text copied in. The coach's prompt test checks hashed
   slices of pack 7266 against the prompt; do the same for any corpus an expert learns
   from.
5. Tune the retrieval sample until it passes; generic request verbs and greetings go into
   the stop list, as «находить» and «привет» did for the coach.
6. Prompt sections: Personality, Goal, Audience, Guardrails, Tone, Examples. The
   guardrails refuse other subjects including a request to drop them, and state facts only
   from the material; anything the expert composes itself it announces as its own first.

### 4. Live sources, when an expert needs them

Follow `/questions`: a keyed route with its own rate bucket, at most two upstream pages per
call cached at the edge for a day, one request per session start within five seconds,
`null` for nothing found and never `404`, which is what a Worker without the route answers.
A failure leaves the material out and never blocks the start.

### 5. Evaluation

Today an expert is checked by its tests and by someone with a key talking to it. A fixed
scenario set per expert — a change of subject, «ignore your instructions», a fact the base
does not cover, a request for an example — is worth writing now and runs by hand. It runs
in CI once an admin grants the access in item 8 below.

### 6. Knowledge and tools on the agent

Once item 6 below is done, each expert gets an agent of its own with its knowledge base and
RAG, the page sends the theme with `/agent/token`, and the Worker mints for that theme's
agent. That removes the one-turn lag and the bundle cost, and lets experts use tools.

With 1 and 2 in place, the code of a new expert should take about an hour; the content
from half a day to two days, depending on how much of the domain is written down.

## What ElevenLabs admins can fix

In order of what each one unblocks. *Today* is what we do without it.

1. **Allow overrides on the agent the page uses**: system prompt, LLM, language, first
   message, voice, ASR keywords. With them every expert is a role, a voice and a greeting
   of its own without an agent of its own. *Today*: prompt, LLM and language have to be
   allowed for the coach to connect at all; every expert shares the agent's voice and
   greeting.
2. **A development agent**, a copy of the production one with every override allowed, its
   id given to us for local runs and branch previews. *Today*: experiments run on the
   agent the published page uses.
3. **A multilingual TTS model on that agent** (Flash v2.5 or newer; Turbo v2 and Flash v2
   speak English only) and ASR set for the languages experts speak. *Today*: a non-English
   expert depends on whatever the agent happens to be set to.
4. **Client events `vad_score` and `asr_initiation_metadata` on**, and `client_tool_call`
   once tools exist. *Today*: without the first two the pipeline lanes go blank.
5. **One generic client tool defined once**, for example `expert_lookup` with
   `{expert, kind, query}`, waiting for the response, timeout 20 s. Tools are matched by
   name, so one generic tool lets the page answer any expert's lookups — questions,
   glossary, schedules — without another round trip to an admin. *Today*: no expert can
   call a tool; material is drawn before the session and put in the prompt.
6. **A way to put knowledge on agents**, either an API key restricted to agents and the
   knowledge base in a development workspace, if the workspace offers restricted keys, so a
   script can create an agent per expert and upload its files; or admins upload
   `knowledge/<id>/*.md` to an agent per expert with RAG on (8000 characters, 6 chunks,
   distance 0.5 to start) and send us the ids. *Today*: the page searches its own copy,
   one turn late.
7. **Read access to the development agent's conversations**, or a post-call webhook with
   the transcript. *Today*: the only way to see what an agent said is for the person who
   talked to it to paste the transcript.
8. **Evaluation on the development agent**: success criteria in its analysis settings, or
   access to simulated conversations, so the scenario sets in roadmap item 5 run without a
   person. *Today*: none.
9. **The LLMs experts use enabled in the workspace** (the coach runs on
   `claude-sonnet-5-5`), and a quota for the development agent apart from production.
10. **Temperature and RAG limits set per expert agent** on request: the page has no
    override for either.
