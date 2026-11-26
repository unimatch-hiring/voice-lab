import { useEffect, useMemo, useState } from "react";
import { createParentApi, type ParentApi } from "./lib/parental/parentApi";
import type { Flag, ParentSettings } from "./lib/parental/types";
import "./scene/tokens.css";
import "./parent.css";

const FIELDS: { key: keyof ParentSettings; label: string; placeholder: string }[] = [
  {
    key: "allowedTopics",
    label: "Topics the child may discuss",
    placeholder: "Space, dinosaurs, maths homework, drawing…",
  },
  {
    key: "blockedTopics",
    label: "Topics the child must not discuss",
    placeholder: "Horror films, politics, anything about money…",
  },
  {
    key: "childProfile",
    label: "About the child",
    placeholder: "Name, age, interests, how they like to be spoken to…",
  },
  {
    key: "triggerWords",
    label: "Extra alarm words",
    placeholder: "Words that should raise a flag, one per line or separated by commas",
  },
];

const UNREACHABLE = "The parental server is not reachable. Start it with npm run server.";

export function Parent({ api: injected }: { api?: ParentApi }) {
  const api = useMemo(() => injected ?? createParentApi(), [injected]);
  const [settings, setSettings] = useState<ParentSettings | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getSettings(), api.listFlags()])
      .then(([s, f]) => {
        if (!alive) return;
        setSettings(s);
        setFlags(f);
      })
      .catch(() => alive && setError(UNREACHABLE));
    return () => {
      alive = false;
    };
  }, [api]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await api.saveSettings(settings));
      setSaved(true);
    } catch {
      setError(UNREACHABLE);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="shell parent-shell">
      <header className="masthead">
        <h1>voice-lab for parents</h1>
        <p>
          What the assistant may talk about with your child, what it must steer away from,
          and who it is talking to. Changes apply from the next conversation.
        </p>
        <p>
          <a href="?">Back to the assistant</a>
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <span className="readout">Settings</span>
        </div>
        <form
          className="panel-body parent-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!settings && !error && <p className="hint">Loading…</p>}
          {settings &&
            FIELDS.map(({ key, label, placeholder }) => (
              <label key={key} className="parent-field">
                <span>{label}</span>
                <textarea
                  rows={4}
                  value={settings[key]}
                  placeholder={placeholder}
                  onChange={(e) => {
                    setSaved(false);
                    setSettings({ ...settings, [key]: e.target.value });
                  }}
                />
              </label>
            ))}
          {settings && (
            <div className="parent-actions">
              <button className="talk" type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              {saved && <span className="hint">Saved.</span>}
            </div>
          )}
          {error && <p className="parent-error">{error}</p>}
        </form>
      </section>

      {settings && (
        <section className="panel">
          <div className="panel-head">
            <span className="readout">Alarm flags</span>
          </div>
          <div className="panel-body">
            {flags.length === 0 ? (
              <p className="hint">Nothing worrying so far.</p>
            ) : (
              <ul className="parent-flags">
                {flags.map((flag) => (
                  <FlagItem key={flag.id} flag={flag} />
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function FlagItem({ flag }: { flag: Flag }) {
  return (
    <li className="parent-flag" data-status={flag.status}>
      <div className="parent-flag-head">
        <time>{new Date(flag.at).toLocaleString()}</time>
        <span>
          {flag.status === "confirmed"
            ? `${flag.category?.replace("_", " ")} · ${flag.severity}`
            : "Not verified: the review was unavailable"}
        </span>
      </div>
      {flag.reason && <p className="parent-flag-reason">{flag.reason}</p>}
      <blockquote>{flag.text}</blockquote>
      <p className="hint">Matched: {flag.matched.join(", ")}</p>
      {flag.context.length > 0 && (
        <details>
          <summary>What was said before</summary>
          <ul>
            {flag.context.map((line, i) => (
              <li key={i}>
                <b>{line.role}:</b> {line.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
