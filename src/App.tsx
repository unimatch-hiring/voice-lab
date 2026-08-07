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
        </div>

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

          {error && <p className="error">{error}</p>}

          <div className="run">
            <Waterfall bus={bus} />
            <Mouth timeline={orch.timeline} playback={playback} />
          </div>

          <StageBreakdown metrics={metrics} busy={busy} />
        </div>
      </section>

      {tokenReady && <TokenGate token={storedToken} onChange={setStoredToken} />}
    </main>
  );
}

/**
 * Client token entry. The published build ships without a token (otherwise our paid
 * quota would go to every visitor), so this is where live mode is unlocked —
 * including on the deployed site, with no local build.
 *
 * Kept visually quiet on purpose: it is a one-time step, not the main control.
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

  if (token) {
    return (
      <p className="setup">
        <span>Live mode is on — the pipeline talks to real services.</span>
        <button
          type="button"
          className="linkish"
          onClick={async () => {
            await saveToken("");
            onChange("");
          }}
        >
          Switch back to fixtures
        </button>
      </p>
    );
  }

  return (
    <form
      className="setup"
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
      <label htmlFor="token">Have a token? Paste it to run the real pipeline.</label>
      <input
        id="token"
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="token"
        // No autoComplete: this is not the user's own password, no reason to offer
        // it to password managers.
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" disabled={saving || !draft.trim()}>
        {saving ? "saving…" : "Enable"}
      </button>
    </form>
  );
}
