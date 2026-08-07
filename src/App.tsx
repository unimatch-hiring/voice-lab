import { useEffect, useMemo, useRef, useState } from "react";
import { EventBus } from "./lib/events";
import { Orchestrator } from "./lib/pipeline/orchestrator";
import { PlaybackQueue } from "./lib/pipeline/playback";
import { Recorder } from "./lib/pipeline/capture";
import { EnergyVad } from "./lib/pipeline/vad";
import { createTransport } from "./lib/transport";
import { transcribe } from "./lib/pipeline/stt";
import { respond } from "./lib/pipeline/llm";
import { synthesize } from "./lib/pipeline/tts";
import { FIXTURES, offlineStages } from "./lib/fixtures";
import { loadConfig } from "./lib/config";
import type { TurnMetrics } from "./lib/types";
import { loadToken, saveToken } from "./lib/tokenStore";
import { Waterfall } from "./scene/Waterfall";
import { StageBreakdown } from "./scene/StageBreakdown";
import { Transcript } from "./scene/Transcript";
import { Mouth } from "./scene/Mouth";
import "./scene/tokens.css";

export function App() {
  // The token comes from IndexedDB, i.e. asynchronously, so config lives in state.
  // The first render is offline and flips to live mode once the token is read.
  const [storedToken, setStoredToken] = useState("");
  const [tokenReady, setTokenReady] = useState(false);
  const config = useMemo(() => loadConfig(storedToken), [storedToken]);

  useEffect(() => {
    let alive = true;
    loadToken().then((t) => {
      if (!alive) return;
      setStoredToken(t);
      setTokenReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const bus = useMemo(() => new EventBus(), []);
  const playback = useMemo(
    () => new PlaybackQueue(new AudioContext() as never),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The waterfall scrolls a 6s window, so a finished turn vanishes from it within
  // seconds. Keeping the metrics means the result of the run stays on screen —
  // which, for a product about honest timings, is the whole point.
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Live input: the level goes to the scene every frame and the VAD marks speech
  // boundaries as the capture and vad stages. Without it two lanes stay empty.
  const recorder = useMemo(() => {
    const vad = new EnergyVad();
    return new Recorder({
      onFrame: ({ samples, rms, at }) => {
        bus.emit({ type: "audio-level", rms, at });
        const event = vad.push(samples);
        if (event === "speech-start") {
          bus.emit({ type: "stage-start", stage: "vad", at });
        } else if (event === "speech-end") {
          bus.emit({ type: "stage-end", stage: "vad", at, ttfbMs: 0 });
        }
      },
    });
  }, [bus]);

  const orch = useMemo(() => {
    if (config.offline) {
      return new Orchestrator({ bus, playback, ...offlineStages(FIXTURES[0]) });
    }
    const transport = createTransport({
      workerUrl: config.workerUrl,
      vibeToken: config.vibeToken,
    });
    return new Orchestrator({
      bus,
      playback,
      transcribe: (audio) => transcribe(audio, { transport }),
      respond: (text, opts) => respond(text, { transport, history: opts.history }),
      synthesize: (text) => synthesize(text, { transport }),
    });
  }, [bus, playback, config]);

  const holding = useRef(false);

  const start = async () => {
    if (holding.current) return;
    holding.current = true;
    setError(null);
    // Do not start the offline turn here: setBusy(true) before mouseup disables the
    // button, the browser swallows the mouseup, and the press never releases. The
    // turn starts from stop(), same as in live mode.
    if (!config.offline) {
      try {
        bus.emit({ type: "stage-start", stage: "capture", at: performance.now() });
        await recorder.start();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        holding.current = false;
      }
    }
  };

  const stop = async () => {
    if (!holding.current) return;
    holding.current = false;
    setBusy(true);
    try {
      let audio: Blob;
      if (config.offline) {
        audio = new Blob([]);
      } else {
        audio = await recorder.stop();
        bus.emit({ type: "stage-end", stage: "capture", at: performance.now(), ttfbMs: 0 });
      }
      setMetrics(await orch.runTurn(audio));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => playback.stop(), [playback]);

  return (
    <main className="shell">
      <header className="masthead">
        <h1>voice-lab</h1>
        <p>
          Hold the button and say something. Every stage of the pipeline reports the
          milliseconds it actually took, and the character articulates the reply from
          the timestamps the speech synthesis returns.
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <span className="mode" data-live={!config.offline}>
            {config.offline ? "fixtures" : "live"}
          </span>
          <span className="spacer" />
          <span>window 6s</span>
          <button
            type="button"
            className="gear"
            aria-expanded={settingsOpen}
            aria-label="Settings"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 5.5A2.5 2.5 0 1 0 8 10.5a2.5 2.5 0 0 0 0-5Zm0 1.4a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z"
              />
              <path
                fill="currentColor"
                d="M6.9.9h2.2l.3 1.7c.4.1.8.3 1.2.5l1.4-1 1.6 1.6-1 1.4c.2.4.4.8.5 1.2l1.7.3v2.2l-1.7.3c-.1.4-.3.8-.5 1.2l1 1.4-1.6 1.6-1.4-1c-.4.2-.8.4-1.2.5l-.3 1.7H6.9l-.3-1.7c-.4-.1-.8-.3-1.2-.5l-1.4 1L2.4 12l1-1.4c-.2-.4-.4-.8-.5-1.2L1.2 9.1V6.9l1.7-.3c.1-.4.3-.8.5-1.2l-1-1.4L4 2.4l1.4 1c.4-.2.8-.4 1.2-.5L6.9.9Zm1.2 1.4-.2 1.3-.8.2c-.5.1-.9.3-1.3.6l-.7.4-1.1-.8-.2.2.8 1.1-.4.7c-.3.4-.5.8-.6 1.3l-.2.8-1.3.2v.2l1.3.2.2.8c.1.5.3.9.6 1.3l.4.7-.8 1.1.2.2 1.1-.8.7.4c.4.3.8.5 1.3.6l.8.2.2 1.3h.2l.2-1.3.8-.2c.5-.1.9-.3 1.3-.6l.7-.4 1.1.8.2-.2-.8-1.1.4-.7c.3-.4.5-.8.6-1.3l.2-.8 1.3-.2V7.9l-1.3-.2-.2-.8c-.1-.5-.3-.9-.6-1.3l-.4-.7.8-1.1-.2-.2-1.1.8-.7-.4c-.4-.3-.8-.5-1.3-.6l-.8-.2-.2-1.3h-.2Z"
              />
            </svg>
          </button>
        </div>

        {settingsOpen && tokenReady && (
          <TokenGate token={storedToken} onChange={setStoredToken} />
        )}

        <div className="panel-body">
          <div className="transport">
            <button
              className="talk"
              onMouseDown={start}
              onMouseUp={stop}
              onMouseLeave={stop}
              disabled={busy}
            >
              {busy ? "working…" : config.offline ? "Run a recorded turn" : "Hold to speak"}
            </button>
            <span className="hint">
              {busy
                ? "Stages report as they finish."
                : config.offline
                  ? "No microphone needed — this replays a recorded turn."
                  : "Release to send. Nothing is stored."}
            </span>
          </div>

          <p className="status-line">{error}</p>

          <div className="run">
            <div className="run-left">
              <Waterfall bus={bus} />
              <Transcript bus={bus} />
            </div>
            <Mouth timeline={orch.timeline} playback={playback} />
          </div>

          <StageBreakdown metrics={metrics} busy={busy} />
        </div>
      </section>

    </main>
  );
}

/**
 * Token settings, opened from the gear in the panel header.
 *
 * The published build ships without a token — baking one in would hand our paid
 * quota to every visitor — so this is where live mode is switched on, and it works
 * on the deployed site with no local build.
 */
function TokenGate({
  token,
  onChange,
}: {
  token: string;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <div className="settings">
      <p className="settings-state">
        <span className="mode" data-live={Boolean(token)}>
          {token ? "Live mode" : "Fixture mode"}
        </span>
        <span className="settings-note">
          {token
            ? "Speech, the model and the voice are the real services."
            : "Recorded turns replay locally. No microphone, no keys, no cost."}
        </span>
      </p>

      {token ? (
        <button
          type="button"
          className="settings-secondary"
          onClick={async () => {
            await saveToken("");
            onChange("");
          }}
        >
          Forget token and use fixtures
        </button>
      ) : (
        <form
          className="settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const next = draft.trim();
            if (!next) return;
            setSaving(true);
            await saveToken(next);
            onChange(next);
            setSaving(false);
            setDraft("");
          }}
        >
          <label htmlFor="token">Access token</label>
          <div className="settings-row">
            <input
              id="token"
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="paste to switch to live mode"
              // No autoComplete: this is not the user's own password, no reason to
              // offer it to password managers.
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={saving || !draft.trim()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="settings-hint">
            Stored encrypted in this browser and kept between reloads.
          </p>
        </form>
      )}
    </div>
  );
}
