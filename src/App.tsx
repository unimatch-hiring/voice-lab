import { useEffect, useMemo, useRef, useState } from "react";
import { EventBus } from "./lib/events";
import { AgentSession } from "./lib/pipeline/agentSession";
import { VisemeTimeline } from "./lib/visemes";
import { createTransport } from "./lib/transport";
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

  // Speech clock for the mouth. Agents plays the audio itself, so there is no playhead to
  // read: the clock starts when the agent starts speaking and the alignment timings are
  // measured from that moment.
  const speechStart = useRef(0);
  const agentPlayhead = useMemo(
    () => ({
      get elapsedMs() {
        return speechStart.current === 0 ? 0 : performance.now() - speechStart.current;
      },
      get isPlaying() {
        return speechStart.current !== 0;
      },
      enqueue: () => {},
      stop: () => {},
    }),
    [],
  );

  // The mouth's shape source. With Agents the audio is played by the SDK, so the timeline
  // is fed from its alignment events instead of from chunks we scheduled ourselves.
  const timeline = useMemo(() => new VisemeTimeline(), []);

  const session = useMemo(() => {
    const transport = createTransport({
      workerUrl: config.workerUrl,
      vibeToken: config.vibeToken,
    });
    return new AgentSession({
      bus,
      transport,
      onAlignment: (chars, startMs, durationMs) => {
        timeline.appendAbsolute(chars, startMs, durationMs);
      },
      onTurn: setMetrics,
      onEnded: (reason, message) => {
        setTalking(false);
        // The agent hanging up is a normal ending, not a failure worth an error style.
        setError(
          reason === "error"
            ? (message ?? "The conversation dropped. Start it again to keep talking.")
            : null,
        );
        setEndedBy(reason);
      },
      onSpeaking: (speaking) => {
        // Restarting the clock per reply keeps the alignment, which is measured from the
        // start of each reply, lined up with the audio.
        speechStart.current = speaking ? performance.now() : 0;
        if (speaking) timeline.reset();
      },
    });
  }, [bus, config, timeline]);

  const toggleConversation = async () => {
    setError(null);
    if (session.isRunning) {
      await session.stop();
      setTalking(false);
      setEndedBy("user");
      return;
    }
    try {
      setEndedBy(null);
      await session.start();
      setTalking(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
          <button
            type="button"
            className="settings-toggle"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            {settingsOpen ? "close" : "settings"}
          </button>
        </div>

        {settingsOpen && tokenReady && (
          <TokenGate
            token={storedToken}
            onChange={setStoredToken}
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
                ? "Add an access token in settings to start talking."
                : talking
                  ? "Listening. Just speak; pauses end your turn."
                  : endedBy === "agent"
                    ? "The agent ended the conversation. Start again whenever you like."
                    : "Your microphone stays open, so you talk and it answers."}
            </span>
          </div>

          <p className="status-line">{error}</p>

          <div className="run">
            <div className="run-left">
              <Waterfall bus={bus} />
              <Transcript bus={bus} />
            </div>
            <Mouth
              timeline={timeline}
              playback={agentPlayhead}
              outputLevel={() => session.outputLevel()}
            />
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
    <div className="settings">
      {token ? (
        <div className="settings-block">
          <p className="settings-state">
            Your microphone, the real speech recognition, model and voice.
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
          <label htmlFor="token">Access token</label>
          <div className="settings-row">
            <input
              id="token"
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="paste to start talking"
              // No autoComplete: this is not the user's own password, no reason to
              // offer it to password managers.
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={saving || !draft.trim()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="settings-hint">Stored encrypted in this browser.</p>
        </form>
      )}


    </div>
  );
}
