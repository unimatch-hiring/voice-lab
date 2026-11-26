# Pipeline

The conversation runs on [ElevenLabs
Agents](https://elevenlabs.io/docs/agents-platform/overview) via
[`@elevenlabs/client`](https://www.npmjs.com/package/@elevenlabs/client) — [SDK
reference](https://elevenlabs.io/docs/agents-platform/libraries/java-script). We do not own the
steps; we own their presentation. [`agentSession.ts`](../src/lib/pipeline/agentSession.ts)
translates SDK events into the stage stream the scene draws.

## Stage mapping

| Stage | Opened by | Closed by |
|---|---|---|
| `capture` | `onModeChange` → `listening` | next mode change |
| `vad` | `onVadScore` crossing 0.5 | score dropping back |
| `stt` | `onAsrInitiationMetadata` | `onMessage` with `source: "user"` |
| `llm` | `onMessage` with `source: "user"` | first `onAudio` |
| `tts` | first `onAudio` | mode leaving `speaking` |
| `playback` | `onModeChange` → `speaking` | next mode change |

`Mode` has only two values — `speaking` and `listening` — so `llm` cannot come from a mode
change and is bracketed between the transcript and the first audio frame. Mode changes drive
one stage at a time; `vad`, `stt`, `llm` and `tts` overlap them and are tracked as lanes. Recognition runs while the agent still listens, and synthesis runs
while it already speaks, so a single "current stage" slot cannot express both.

A lane draws only if the agent is configured to send the event that opens it. `client_events`
lives on the agent, not in this repo and not in anything the client can override, so `vad`
and `stt` go permanently blank when `vad_score` and `asr_initiation_metadata` are missing
from it — with no error anywhere. A dead lane is a question about the agent first and about
this code second.

## Turn boundaries

Returning to `listening` ends a turn: metrics are reported and a fresh turn starts. Stage
durations come from the time between the events, not from anything the SDK reports.

## Ending

`onDisconnect` reports who ended it — `user`, `agent` or `error`. All three must close the
open lanes, or a stage stays open forever behind a dead socket.

## Why not our own pipeline

An earlier version ran capture → VAD → STT → LLM → TTS → playback by hand. Three defects
were structural rather than fixable:

- The microphone heard the agent through the speakers. Browser echo cancellation only
  covers audio from the same context, and playback had its own, so every reply read as
  user speech and cut itself off.
- An energy threshold cannot separate a voice from a barking dog. Silero VAD answers that
  question, but the package is CommonJS and its onnxruntime fetches wasm at runtime, which
  Vite serves with a `?import` suffix it then refuses.
- Chunks arriving after the queue drained were scheduled at "now", leaving audible gaps.

Agents solves all three at the source: input and output share one audio context, the
detector is theirs, playback is theirs.

## Who decides the role

The prompt the agent answers with is not the one configured in the ElevenLabs dashboard:
`src/lib/persona.ts` overrides it in the handshake (`conversation_initiation_client_data`).
Two consequences. It applies **once, at session start** — a running conversation keeps the
role it opened with, so switching roles means a new session. And the agent must permit the
override: with it disallowed the server closes the connection instead of ignoring the
field, which reaches the page as a dropped conversation rather than an error about prompts.

## Form, tools and fact marks

Three observers sit on the bus beside the scene; none of them is in the session.

- [`supervisor.ts`](../src/lib/supervisor.ts) fills the form without relying on tool calls.
  On `agent-reply` it parses the read-back the prompt prescribes ("Записываю телефон: … Верно?",
  [`readBack.ts`](../src/lib/readBack.ts)) and holds it until the next `stt-result`: only a "да"
  puts it in the form, so a mis-heard value never lands. A date is put through the tools' own check (`dateRefusal`: a real day, not gone, not a Sunday) in whatever form it was read back, and is not filled otherwise. A name, phone
  or plate the customer said themselves waits the same way: it is filled once the agent repeats
  it, in any wording, and the customer says yes. It sends, once each, a stop-driving hint for
  unsafe symptoms and a correction when the agent claims a booking before `book_appointment` has succeeded. Both
  sessions emit `turn-end` where they report a turn (listening resumes), and on it the supervisor
  sends the "form still missing" nudge, once per change in what is missing.
- [`tools.ts`](../src/lib/tools.ts) is the one tool list for both engines: `search_services`,
  `find_slots`, `book_appointment`, `update_form`. Each run emits `tool-result` with the facts it
  handed the agent. **On ElevenLabs they run only if the same names are declared as client tools
  on the agent in the dashboard**; undeclared, the agent never calls them and only the
  supervisor fills the form.
  Confirmation is explicit state, not the model's word: [`confirmed.ts`](../src/lib/confirmed.ts)
  is a per-call ledger the supervisor adds to on each yes to a read-back, and `update_form`
  saves a value only if it is in the ledger (phones compared by their last ten digits),
  answering `not confirmed` for the rest. A value typed into the form or kept from an earlier
  call is not a confirmation, and Clear profile emits `profile-cleared`, on which the supervisor
  drops the ledger along with the value waiting for a yes and what the customer had said. `find_slots` and `book_appointment` refuse a time already gone
  today as well as a day already gone, and a booking needs the form valid, not merely filled.
- [`annotate.ts`](../src/scene/annotate.ts) marks the agent's words in the transcript: a name or
  number is a *fact* when the prompt's shop facts and price list or a `tool-result` back it, and
  an *assumption* otherwise, as are hedge words. A fact line written `subject: values`
  (`Замена масла, Oil change: 2500 ₽, 30 min`) binds its values to that subject, and a number
  is checked as subject → field → value → unit:
  - the subject is the service named in the same clause, else the same sentence, else the last
    one named in the reply; with none named, every source is searched;
  - the field is the unit: a price beside a service must be *that* service's price, and
    "6 months" backs neither "6 лет" nor "6 минут";
  - a day followed by a month name must match a known date in both; a phone's digits back only
    a bare number; a number after "не"/"not" is never a fact, across a range too
    ("не с 09:00 до 19:00").

  It is a heuristic on text, not a check of the agent's reasoning: two services swapped inside
  one clause still pass.

## Backup engine: Deepgram

When ElevenLabs is down, a key can be switched to [Deepgram's Voice Agent
API](https://developers.deepgram.com/docs/voice-agent) in the admin page.
[`deepgramSession.ts`](../src/lib/pipeline/deepgramSession.ts) implements the same
`VoiceSession` as `agentSession.ts`, so the page does not know which one it runs.

What differs, and why the page says so:

- One WebSocket carries everything: `Settings` after `Welcome`, microphone PCM after
  `SettingsApplied`, agent PCM back. There is no SDK; capture and playback are ours
  ([`deepgramAudio.ts`](../src/lib/pipeline/deepgramAudio.ts)), on one `AudioContext` for
  the echo reason above.
- The role, the models and the functions go in `Settings`. Functions run in the page:
  `FunctionCallRequest` → `FunctionCallResponse` with the same `id`, and nothing for a
  call named in `FunctionCallCancelled`.
- `sendUserMessage`, `sendContextualUpdate` and `injectAgentMessage` map to `InjectUserMessage`,
  `UpdatePrompt` (appends, never replaces) and `InjectAgentMessage`. So on Deepgram every
  supervisor nudge stays in the prompt: "Form still missing: phone" outlives the phone being
  given, and nothing is sent once the form is complete. The same text is appended only once
  per call. Treat nudges there as advisory.
- `UserStartedSpeaking` is the barge-in signal: queued agent audio is dropped. A reply ends
  when local playback drains, not at `AgentAudioDone`, which only means the last chunk left
  the server.
- Aura voices are English-only, hence the notice on the page.

| Stage | Opened by | Closed by |
|---|---|---|
| `capture` | `SettingsApplied`, `UserStartedSpeaking`, playback draining | next stage |
| `stt` | `UserStartedSpeaking` | user `ConversationText` |
| `llm` | user `ConversationText` | first agent audio |
| `tts` | first agent audio | `AgentAudioDone` or barge-in |
| `playback` | first agent audio | playback draining or barge-in |

There is no speech-probability event, so `vad` stays blank on this engine.
