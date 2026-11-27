import { useEffect, useMemo, useReducer, useState, type FormEvent } from "react";
import type { Child, ChildFields, ChildSummary, Rule } from "../../shared/parent";
import { loadConfig } from "../lib/config";
import { routeHref } from "../lib/route";
import { AlertList } from "./AlertList";
import { parentApi } from "./api";

type Draft = Omit<ChildFields, "age"> & { age: string };
const emptyDraft: Draft = { displayName: "", age: "", note: "", ruleIds: [] };

function draftFrom(child: Child): Draft {
  return {
    displayName: child.displayName,
    age: child.age === null ? "" : String(child.age),
    note: child.note,
    ruleIds: child.ruleIds,
  };
}

export function ParentControl({
  serverUrl = loadConfig().childServerUrl, fetchImpl = fetch,
}: { serverUrl?: string; fetchImpl?: typeof fetch } = {}) {
  const api = useMemo(() => parentApi(serverUrl, fetchImpl), [serverUrl, fetchImpl]);
  const [children, setChildren] = useState<ChildSummary[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [child, setChild] = useState<Child | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [ruleLabel, setRuleLabel] = useState("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [readVersion, refreshCounts] = useReducer((version: number) => version + 1, 0);
  const base = import.meta.env.BASE_URL;
  const link = child ? new URL(routeHref({ childId: child.id }), location.origin).href : "";

  useEffect(() => {
    if (!serverUrl) return;
    const stop = new AbortController();
    setLoading(true);
    Promise.all([api.children(stop.signal), api.rules(stop.signal)])
      .then(([children, rules]) => {
        if (stop.signal.aborted) return;
        setChildren(children);
        setRules(rules);
        setReady(true);
      })
      .catch(() => {
        if (!stop.signal.aborted) setError("Could not load profiles. Check that the server is running.");
      })
      .finally(() => {
        if (!stop.signal.aborted) setLoading(false);
      });
    return () => stop.abort();
  }, [api, retry, serverUrl]);

  useEffect(() => {
    if (!readVersion || !serverUrl) return;
    const stop = new AbortController();
    void api.children(stop.signal).then((fresh) => {
      if (stop.signal.aborted) return;
      setChildren((current) => current.map((item) => ({
        ...item, unreadAlerts: fresh.find(({ id }) => id === item.id)?.unreadAlerts ?? item.unreadAlerts,
      })));
    }).catch(() => {});
    return () => stop.abort();
  }, [api, readVersion, serverUrl]);

  function showProfile(profile: Child | null) {
    setChild(profile);
    setDraft(profile ? draftFrom(profile) : emptyDraft);
  }

  async function act(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  function selectChild(id: string | null) {
    if (id === (child?.id ?? null)) return;
    const saved = child ? draftFrom(child) : emptyDraft;
    if (JSON.stringify(saved) !== JSON.stringify(draft) &&
        !window.confirm("Switch profiles without saving your changes?")) return;
    void act(async () => showProfile(id ? await api.child(id) : null),
      "Could not open the profile. Try again.");
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    void act(async () => {
      const updated = await api.save({
        ...draft,
        age: draft.age === "" ? null : Number(draft.age),
      }, child?.id);
      const { id, displayName, age } = updated;
      setChildren((items) => [
        ...items.filter((item) => item.id !== id),
        { id, displayName, age, unreadAlerts: items.find((item) => item.id === id)?.unreadAlerts ?? 0 },
      ]);
      showProfile(updated);
      setStatus(child ? "Changes saved." : "Profile created.");
    }, "Could not save the profile. Try again.");
  }

  function remove() {
    if (!child || !window.confirm(`Delete the profile for “${child.displayName}” and its history?`)) return;
    void act(async () => {
      await api.remove(child.id);
      setChildren((items) => items.filter(({ id }) => id !== child.id));
      showProfile(null);
      setStatus("Profile deleted.");
    }, "Could not delete the profile. Try again.");
  }

  function toggleRule(id: number, checked: boolean) {
    setDraft((current) => ({
      ...current,
      ruleIds: checked ? [...new Set([...current.ruleIds, id])].sort((a, b) => a - b)
        : current.ruleIds.filter((ruleId) => ruleId !== id),
    }));
  }

  function addRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ruleLabel.trim()) return;
    void act(async () => {
      const rule = await api.addRule(ruleLabel);
      setRules((items) => items.some(({ id }) => id === rule.id) ? items : [...items, rule]);
      toggleRule(rule.id, true);
      setRuleLabel("");
      setStatus("Topic added to the shared list.");
    }, "Could not add the topic. Try again.");
  }

  return (
    <main className="shell parent-shell">
      <header className="masthead">
        <a href={base}>voice-lab</a>
        <h1>Child profiles</h1>
        <a href={routeHref("alerts")}>Alerts</a>
      </header>
      {!serverUrl && <p role="status">Set the server URL to manage profiles.</p>}
      {loading && <p role="status">Loading profiles…</p>}
      {error && <p className="parent-error" role="alert">{error}</p>}
      {!ready && error && (
        <button className="parent-button" type="button" onClick={() => { setError(""); setRetry(retry + 1); }}>
          Retry
        </button>
      )}
      {ready && (
        <div className="parent-layout">
          <aside className="panel parent-list" aria-label="Profile list">
            <button className="parent-button" type="button" disabled={busy}
              aria-pressed={!child} onClick={() => selectChild(null)}>
              New profile
            </button>
            {children.length === 0 && <p className="parent-muted">No profiles yet.</p>}
            {children.length > 0 && (
              <ul>
                {[...children].sort((a, b) => a.displayName.localeCompare(b.displayName, "en-GB")).map((item) => (
                  <li key={item.id}>
                    <button className="parent-child" type="button" disabled={busy}
                      aria-pressed={child?.id === item.id} onClick={() => selectChild(item.id)}>
                      {item.displayName}
                      {!!item.unreadAlerts && (
                        <span className="parent-alert-count" aria-label={`Unread alerts: ${item.unreadAlerts}`}>
                          {item.unreadAlerts}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          <section className="panel parent-editor" aria-labelledby="profile-heading" aria-busy={busy}>
            <h2 id="profile-heading">{child ? child.displayName : "New profile"}</h2>
            {child && (
              <div className="parent-link">
                <span>Child link</span>
                <a href={link}>{link}</a>
              </div>
            )}
            <form id="add-topic" onSubmit={addRule} />
            <form onSubmit={save}>
              <fieldset disabled={busy} className="parent-fields">
                <div className="parent-identity">
                  <label>
                    Name
                    <input required maxLength={120} value={draft.displayName}
                      onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
                  </label>
                  <label>
                    Age <span className="parent-muted">· optional</span>
                    <input type="number" min={0} max={120} step={1} value={draft.age}
                      onChange={(event) => setDraft({ ...draft, age: event.target.value })} />
                  </label>
                </div>
                <label>
                  Note
                  <textarea rows={3} maxLength={4000} value={draft.note}
                    placeholder="For example, likes space and prefers short replies"
                    onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
                </label>
                <fieldset className="parent-topics">
                  <legend>Forbidden topics</legend>
                  {rules.length === 0 && <p className="parent-muted">No topics yet.</p>}
                  {rules.map((rule) => (
                    <label key={rule.id} className="parent-topic">
                      <input type="checkbox" checked={draft.ruleIds.includes(rule.id)}
                        onChange={(event) => toggleRule(rule.id, event.target.checked)} />
                      {rule.label}
                    </label>
                  ))}
                  <div className="parent-add">
                    <label>
                      New topic
                      <input form="add-topic" required maxLength={500} value={ruleLabel}
                        onChange={(event) => setRuleLabel(event.target.value)} />
                    </label>
                    <button className="parent-button" type="submit" form="add-topic" disabled={!ruleLabel.trim()}>
                      Add topic
                    </button>
                  </div>
                </fieldset>
                <div className="parent-actions">
                  <button className="parent-button parent-primary" type="submit">
                    {child ? "Save changes" : "Create profile"}
                  </button>
                  {child && <button className="parent-button parent-delete" type="button" onClick={remove}>Delete profile</button>}
                </div>
              </fieldset>
            </form>
            <p className="parent-status" role="status">{status}</p>
          </section>
          {child && (
            <div className="parent-profile-alerts">
              <AlertList key={child.id} childId={child.id} api={api} onRead={refreshCounts} />
            </div>
          )}
        </div>
      )}
    </main>
  );
}
