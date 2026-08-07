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
import { loadToken, saveToken } from "./lib/tokenStore";
import { Waterfall } from "./scene/Waterfall";
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
      await orch.runTurn(audio);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => playback.stop(), [playback]);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 20px" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>voice-lab</h1>
      <p style={{ color: "rgba(16,21,28,0.6)", marginTop: 0 }}>
        Say a phrase and watch it flow through a voice-agent pipeline.
        {config.offline && " Offline right now: replaying recorded fixtures."}
      </p>

      <button
        onMouseDown={start}
        onMouseUp={stop}
        onMouseLeave={stop}
        disabled={busy}
        style={{ padding: "10px 18px", fontSize: 15, borderRadius: 8, cursor: "pointer" }}
      >
        {busy ? "working…" : config.offline ? "run a fixture" : "hold and speak"}
      </button>

      {error && (
        <p style={{ color: "var(--fail)", fontSize: 13 }}>{error}</p>
      )}

      {tokenReady && <TokenGate token={storedToken} onChange={setStoredToken} />}

      <div style={{ marginTop: 24 }}>
        <Waterfall bus={bus} />
      </div>

      <div style={{ marginTop: 20, display: "flex", justifyContent: "center" }}>
        <Mouth timeline={orch.timeline} playback={playback} />
      </div>
    </main>
  );
}

/**
 * Client token entry, right on the page. The published build ships without a token
 * (otherwise our paid quota would go to every visitor), so this is where the live
 * pipeline is unlocked — including on the deployed site, with no local build.
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
      <p style={{ fontSize: 13, color: "rgba(16,21,28,0.6)", marginTop: 12 }}>
        Live mode is on.{" "}
        <button
          type="button"
          onClick={async () => {
            await saveToken("");
            onChange("");
          }}
          style={{
            border: 0,
            background: "none",
            padding: 0,
            font: "inherit",
            color: "var(--running)",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          turn off
        </button>
      </p>
    );
  }

  return (
    <form
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
      style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}
    >
      <input
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="token for live mode"
        // No autoComplete: this is not the user's own password, no reason to offer
        // it to password managers.
        autoComplete="off"
        spellCheck={false}
        style={{
          padding: "7px 10px",
          fontSize: 13,
          borderRadius: 6,
          border: "1px solid rgba(16,21,28,0.2)",
          width: 260,
        }}
      />
      <button
        type="submit"
        disabled={saving || !draft.trim()}
        style={{ padding: "7px 14px", fontSize: 13, borderRadius: 6, cursor: "pointer" }}
      >
        enable
      </button>
    </form>
  );
}
