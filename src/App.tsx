import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventBus } from "./lib/events";
import { AgentSession } from "./lib/pipeline/agentSession";
import { LayerStack } from "./lib/pipeline/layers/orchestrator";
import { liveLayerLlm } from "./lib/pipeline/layers/llm";
import { personaFor } from "./lib/persona";
import { createTransport } from "./lib/transport";
import { loadConfig } from "./lib/config";
import type { TurnMetrics } from "./lib/types";
import { loadToken, saveToken } from "./lib/tokenStore";
import { Recorder, fixtureFilename, toFixtureJson } from "./lib/recorder";
import { Waterfall } from "./scene/Waterfall";
import { StageBreakdown } from "./scene/StageBreakdown";
import { Transcript } from "./scene/Transcript";
import { Mouth } from "./scene/Mouth";
import "./scene/tokens.css";

/**
 * Turns a failed start into something the visitor can act on. The browser's own wording
 * for a denied microphone ("Permission denied") does not say which permission, or where.
 */
export function startFailureMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  const raw = e instanceof Error ? e.message : String(e);

  if (name === "NotAllowedError" || /permission|denied/i.test(raw)) {
    return "The microphone is blocked. Allow it in the address bar, then start again.";
  }
  if (name === "NotFoundError") {
    return "No microphone found. Connect one and start again.";
  }
  if (/401|403|token/i.test(raw)) {
    return "The access token was rejected. Open settings and paste it again.";
  }
  return raw;
}

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
  const [error, setError] = useState<string | null>(null);
  // The waterfall scrolls a 6s window, so a finished turn vanishes from it within
  // seconds. Keeping the metrics means the result of the run stays on screen —
  // which, for a product about honest timings, is the whole point.
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [talking, setTalking] = useState(false);
  /** Who ended the last conversation, so the transport row can say so. */
  const [endedBy, setEndedBy] = useState<"user" | "agent" | "error" | null>(null);
  // Detection knobs, adjustable between sessions from the settings panel.

  // Fixture recording, ours and off by default: `?record` adds a control that saves the
  // conversation to a JSON file.
  const recording = useMemo(() => new URLSearchParams(location.search).has("record"), []);
  const recorder = useMemo(() => new Recorder(bus), [bus]);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  // The session is built before the save helper exists, and its `onEnded` needs to call it.
  const saveRecordingRef = useRef<(() => void) | null>(null);

  const session = useMemo(() => {
    const transport = createTransport({
      workerUrl: config.workerUrl,
      vibeToken: config.vibeToken,
    });
    const persona = personaFor(new URLSearchParams(location.search).get("role"));
    // The stack pushes context through the session, and the session drives the stack, so
    // one of the two has to be named before it exists. The closure resolves at call time.
    let live: AgentSession;
    const layers = new LayerStack({
      bus,
      llm: liveLayerLlm({ transport }),
      persona,
      pushContext: (text) => live.pushContext(text),
    });
    live = new AgentSession({
      bus,
      transport,
      persona,
      layers,
      onTurn: (turn) => {
        setMetrics(turn);
        recorder.addTurn(turn);
      },
      onEnded: (reason, message) => {
        setTalking(false);
        // The agent can hang up on its own, in which case the transport button is never
        // pressed — without this the recording of that conversation is simply lost.
        if (reason !== "user") saveRecordingRef.current?.();
        // The agent hanging up is a normal ending, not a failure worth an error style.
        setError(
          reason === "error"
            ? (message ?? "The conversation dropped. Start it again to keep talking.")
            : null,
        );
        setEndedBy(reason);
      },
    });
    return live;
  }, [bus, config, recorder]);

  // Stable across renders on purpose. The mouth's animation loop depends on this
  // callback, and handing it a fresh arrow every render used to tear the loop down
  // mid-reply and leave the character frozen with its mouth open.
  const mouthSource = useCallback(() => session.mouthSpectrum(), [session]);

  /** Downloads the finished conversation as a fixture file. */
  const saveRecording = () => {
    const conversation = recorder.stop();
    if (!conversation) return;

    const name = fixtureFilename(conversation);
    const url = URL.createObjectURL(
      new Blob([toFixtureJson(conversation)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    setSavedAs(name);
  };
  saveRecordingRef.current = recording ? saveRecording : null;

  const toggleConversation = async () => {
    setError(null);
    if (session.isRunning) {
      await session.stop();
      setTalking(false);
      setEndedBy("user");
      if (recording) saveRecording();
      return;
    }
    try {
      setEndedBy(null);
      if (recording) {
        setSavedAs(null);
        recorder.start();
      }
      await session.start();
      setTalking(true);
    } catch (e) {
      setError(startFailureMessage(e));
      setTalking(false);
    }
  };

  useEffect(
    () => () => {
      void session.stop();
    },
    [session],
  );

  return (
    <main className="shell">
      <header className="masthead">
        <h1>voice-lab</h1>
        <p>
          Start talking and it answers back. Every stage of the pipeline reports the
          milliseconds it actually took, and the character articulates the reply from the
          real loudness of the voice you are hearing.
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <span className="mode" data-live={!config.offline}>
            {config.offline ? "no token" : "live"}
          </span>
          <span className="spacer" />
          <span>window 6s</span>
          {/* With no token the gate is open anyway, so the toggle would move nothing. */}
          {!config.offline && (
            <button
              type="button"
              className="settings-toggle"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              {settingsOpen ? "close" : "settings"}
            </button>
          )}
        </div>

        {/* Without a token nothing runs, so the field is on screen, not behind the toggle. */}
        {tokenReady && (config.offline || settingsOpen) && (
          <TokenGate
            token={storedToken}
            onChange={(next) => {
              setStoredToken(next);
              setSettingsOpen(false);
            }}
          />
        )}

        <div className="panel-body">
          <div className="transport">
            <button
              className="talk"
              data-talking={talking}
              onClick={toggleConversation}
              disabled={config.offline}
            >
              {talking ? "End conversation" : "Start conversation"}
            </button>
            <span className="hint">
              {config.offline
                ? "Paste the access token above to start talking."
                : talking
                  ? "Listening. Just speak; pauses end your turn."
                  : endedBy === "agent"
                    ? "The agent ended the conversation. Start again whenever you like."
                    : "Step 2 — press it, allow the microphone, then just talk."}
            </span>
          </div>

          {recording && (
            <p className="hint">
              {talking
                ? "Recording. The conversation downloads as a fixture when it ends."
                : (savedAs ?? "Fixture recording is on for this tab.")}
            </p>
          )}

          <p className="status-line">{error}</p>

          <div className="run">
            <div className="run-left">
              <Waterfall bus={bus} />
              <Transcript bus={bus} />
            </div>
            <Mouth source={mouthSource} />
          </div>

          <StageBreakdown metrics={metrics} />
        </div>
      </section>

    </main>
  );
}

/**
 * Settings, folded away behind the header toggle: the token that unlocks live mode,
 * plus the two audio knobs that decide when a turn ends. Both matter in practice —
 * room noise differs, and a threshold tuned in a quiet room clips words in a loud one.
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
    <div className="settings" data-gate={!token}>
      {token ? (
        <div className="settings-block">
          <p className="settings-state">
            Token saved. Press “Start conversation” below and allow the microphone.
          </p>
          <button
            type="button"
            className="settings-secondary"
            onClick={async () => {
              await saveToken("");
              onChange("");
            }}
          >
            Forget token
          </button>
        </div>
      ) : (
        <form
          className="settings-block"
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
          <label htmlFor="token">Step 1 — paste your access token</label>
          <div className="settings-row">
            <input
              id="token"
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="vibe_…"
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
            The token came with your invite. Stored encrypted in this browser, so you
            paste it once.
          </p>
        </form>
      )}


    </div>
  );
}
