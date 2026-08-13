import { useCallback, useEffect, useState } from "react";
import {
  AdminUnauthorized,
  createAdminClient,
  formatRemaining,
  type InterviewKey,
} from "./lib/adminKeys";
import { loadConfig } from "./lib/config";
import { loadAdminToken, saveAdminToken, clearAdminToken } from "./lib/tokenStore";
import "./scene/tokens.css";
import "./admin.css";

const TTL_CHOICES = [2, 4, 8];

/**
 * Issues the interview keys we hand candidates. Not linked from anywhere — but the
 * protection is the password, not the obscurity of the path: this route mints credentials
 * that spend our ElevenLabs quota.
 */
export function Admin() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [keys, setKeys] = useState<InterviewKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState(4);
  const [label, setLabel] = useState("");
  /** The key just minted, held apart from the list so it can be shown big and copied. */
  const [fresh, setFresh] = useState<InterviewKey | null>(null);
  const [copied, setCopied] = useState(false);
  // Re-rendered once a minute so "3h 40m left" does not quietly go stale on screen.
  const [now, setNow] = useState(() => Date.now());

  const { workerUrl } = loadConfig();

  const refresh = useCallback(
    async (secret: string) => {
      const client = createAdminClient(workerUrl, secret);
      const list = await client.list();
      setKeys(list);
      setAuthed(true);
      setError(null);
    },
    [workerUrl],
  );

  // The password survives a reload the same way the candidate token does — encrypted under
  // a non-extractable key — so a refresh mid-interview does not lock us out of our own tool.
  useEffect(() => {
    let alive = true;
    loadAdminToken().then((saved) => {
      if (!alive || !saved) return;
      setPassword(saved);
      refresh(saved).catch(() => clearAdminToken());
    });
    return () => {
      alive = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!authed) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [authed]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof AdminUnauthorized ? "Wrong password." : String(e));
      if (e instanceof AdminUnauthorized) setAuthed(false);
    } finally {
      setBusy(false);
    }
  };

  const signIn = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await refresh(password);
      await saveAdminToken(password);
    });
  };

  const issue = () =>
    run(async () => {
      const client = createAdminClient(workerUrl, password);
      const key = await client.issue(hours, label.trim());
      setFresh(key);
      setCopied(false);
      setLabel("");
      setKeys(await client.list());
    });

  const revoke = (token: string) =>
    run(async () => {
      const client = createAdminClient(workerUrl, password);
      await client.revoke(token);
      if (fresh?.token === token) setFresh(null);
      setKeys(await client.list());
    });

  const copy = async (token: string) => {
    await navigator.clipboard.writeText(token);
    setCopied(true);
  };

  const signOut = () => {
    clearAdminToken();
    setAuthed(false);
    setPassword("");
    setKeys([]);
    setFresh(null);
  };

  if (!authed) {
    return (
      <main className="shell admin-shell">
        <header className="masthead">
          <h1>voice-lab admin</h1>
          <p>Interview keys.</p>
        </header>
        <section className="panel">
          <form className="panel-body admin-signin" onSubmit={signIn}>
            <label htmlFor="admin-pw">Admin password</label>
            <input
              id="admin-pw"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="talk" type="submit" disabled={busy || !password}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            {error && <p className="admin-error">{error}</p>}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="shell admin-shell">
      <header className="masthead">
        <h1>voice-lab admin</h1>
        <p>Issue a key for the session, revoke it when the session ends.</p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <span className="readout">Issue a key</span>
          <span className="spacer" />
          <button className="admin-link" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
        <div className="panel-body admin-issue">
          <label htmlFor="admin-label">Who is it for</label>
          <input
            id="admin-label"
            value={label}
            placeholder="Candidate name"
            onChange={(e) => setLabel(e.target.value)}
          />

          <span className="admin-ttl-label">Valid for</span>
          <div className="admin-ttl">
            {TTL_CHOICES.map((h) => (
              <button
                key={h}
                type="button"
                className="admin-chip"
                data-on={hours === h}
                onClick={() => setHours(h)}
              >
                {h}h
              </button>
            ))}
          </div>

          <button className="talk" type="button" onClick={issue} disabled={busy}>
            {busy ? "Working…" : "Issue key"}
          </button>

          {fresh && (
            <div className="admin-fresh">
              <code>{fresh.token}</code>
              <button className="admin-copy" type="button" onClick={() => copy(fresh.token)}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          {error && <p className="admin-error">{error}</p>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="readout">Active keys</span>
        </div>
        <div className="panel-body">
          {keys.length === 0 ? (
            <p className="hint">No keys issued. Expired ones disappear on their own.</p>
          ) : (
            <ul className="admin-list">
              {keys.map((k) => (
                <li key={k.token}>
                  <span className="admin-who">{k.label || "unnamed"}</span>
                  <code className="admin-token">{k.token}</code>
                  <span className="admin-left">{formatRemaining(k.expiresAt, now)}</span>
                  <button className="admin-link" type="button" onClick={() => revoke(k.token)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
