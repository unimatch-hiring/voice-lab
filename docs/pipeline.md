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
