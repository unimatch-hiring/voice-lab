# English tutor

`voice-lab` is a visual explainer of a live voice-agent pipeline. The conversation itself
runs on ElevenLabs Agents; this repository provides the browser UI, a Worker that mints
short-lived session tokens, the tutor policy, and the visualisation of the pipeline.

The agent is an English tutor for short spoken conversations. It is not a general-purpose
assistant and it does not execute code, call arbitrary tools, or access learner data beyond
the lesson record stored in the current browser.

## What happens in a conversation

1. The browser obtains a session token from the deployed Worker and opens an ElevenLabs
   conversation through `AgentSession`.
2. The session handshake sends the tutor role from `src/lib/persona.ts`. Once a new
   conversation is live, the tutor explicitly directs the agent to ask the learner's level.
   A remembered English level is appended to the prompt before the agent can make its first
   reply.
3. ElevenLabs owns audio capture, VAD, speech recognition, language-model generation,
   synthesis and playback. `src/lib/pipeline/agentSession.ts` translates its callbacks
   into application events; it does not implement another voice pipeline.
4. `Tutor` listens to recognised *user* utterances on the same event bus used by the
   visualisation. It runs a pure lesson reducer and sends any resulting instruction back
   to the live agent as a contextual update.
5. The scene renders the stage timings, transcript, mouth movement, level and correction
   record. Scene modules receive events and never import the pipeline implementation.

Contextual updates begin with `[TUTOR DIRECTIVE]`. The prompt tells the agent to treat them
as instructions rather than learner speech, and never speak or quote them aloud.

## Level and lesson memory

The lesson record is stored in IndexedDB in `voice-lab-lesson`. It is local to one browser;
there is no account, server-side profile or cross-device synchronisation.

- A learner may state a level in English or Russian. Recognised values are A1, A2, B1, B2,
  C1 and C2.
- If they decline twice, the tutor asks ordinary questions and estimates A2, B1 or C1 from
  three English answers. An estimated level is announced as “around B1”, not as a precise
  score.
- A stored level and the correction record survive a reload and a new conversation. The
  start button waits for the restore to finish, so the handshake cannot race it.
- `Reset level` forgets only the level and prompts the agent to ask again. `Clear` forgets
  only the correction record. Both changes are persisted.
- Private browsing or an unavailable IndexedDB degrades safely to a fresh lesson; it must
  not prevent the page from loading.

## Language policy

The tutor speaks English even if the learner speaks Russian. The language detector uses the
recognised transcript, not audio, and categorises it as English, Russian, mixed, or unknown.

- Empty transcripts, punctuation, numbers and common fillers do not count as English or
  Russian.
- A mostly English sentence containing one Russian vocabulary gap is accepted as English.
- Mixed utterances do not advance or clear the Russian-steering ladder.
- Consecutive Russian utterances receive: a warm invitation to try English, then a firmer
  reminder, then an offer to stop for the day. The offer is made once; later Russian turns
  return to the steady reminder. Nothing automatically hangs up the call.

The update is necessarily based on a completed transcript, so ElevenLabs may apply it to the
current reply or the next one. A contextual update is guidance for the model, not a hard
real-time audio gate.

## Corrections the application records

The agent is asked to correct naturally and briefly: repeat a better version, name one
important fix, then continue the conversation. The app additionally records only narrow,
deterministic patterns that can be shown and counted reliably.

Current rule families include:

- `to + infinitive` after verbs such as “like” or “want”;
- `listen to`;
- “I agree” rather than “I am agree”;
- third-person singular verb forms (`she has`, `he goes`);
- uncountable nouns (`advice`, `information`);
- double comparatives (`more better`);
- common preposition and collocation errors such as `interested in`, `depend on`,
  `different from`, `in the picture`, and `take a photo`.

Several matching rules can repair one sentence, but the prompt still asks the agent to teach
only one issue per spoken turn. After the same stored rule is seen three times, the tutor asks
the agent to work a discreet practice question into a later reply. It does not announce a
test.

This is intentionally not a grammar checker. Regex rules cannot reliably identify meaning,
register, accents or ASR mistakes, and a false correction is worse than a missed one. The
agent may notice other mistakes conversationally, but only the supported rule table becomes
durable data on screen.

## Conversation boundaries

Allowed subjects are everyday, safe conversation: daily life, food and cooking, travel,
work and study, hobbies, films, music, sport, weather, pets, family and weekend plans.
Roleplay and simple spoken games are also allowed when they serve English practice.

The prompt directs the tutor not to discuss weapons, violence, crime, drugs, sex, self-harm,
illness in detail or politics. It should respond warmly, state that lessons stay on everyday
subjects, and offer an alternative topic.

These topic boundaries are prompt-level behaviour, not a security boundary. A learner can
try prompt-injection patterns such as roleplay, translation or quoted instructions. The
application has no privileged tools or sensitive backend actions for such a prompt to unlock.
If a future version adds tools or consequential actions, their permissions and input checks
must be enforced outside the model, on the server or tool boundary.

## Important implementation boundaries

- `src/scene/*` may import shared `types.ts` and `events.ts`, but never
  `src/lib/pipeline/*`.
- High-frequency audio, token and stage data stays in refs. One animation frame draws it;
  those events must not cause React renders.
- The Worker only mints tokens. It does not receive or process conversation audio.
- The page does not depend on the optional ElevenLabs `firstMessage` override. The agent's
  dashboard greeting may happen first, after which the page sends its level directive.
- `sendContextualUpdate()` has no delivery acknowledgement. The tutor can know whether it
  had a conversation object to hand an instruction to, but cannot prove that ElevenLabs used
  it in a reply.

## Verification

Run the repository checks before review or merge:

```sh
npm ci
npm test
npm run build
```

The tests drive ElevenLabs SDK callbacks directly; a real conversation needs a deployed
Worker and a token. Key coverage includes the lesson reducer, language classification,
correction rules, persistence, the React wiring, and the no-render-per-frame invariant.

For detailed rationale and module-level design, see [docs/tutor.md](docs/tutor.md),
[docs/pipeline.md](docs/pipeline.md), [docs/conventions.md](docs/conventions.md), and
[README.md](README.md).
