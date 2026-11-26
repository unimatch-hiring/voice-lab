import type { Dialogue } from "./historyApi";
import type { PipelineEvent } from "./types";

type HistorySession = Dialogue["sessions"][number];
type EndReason = NonNullable<HistorySession["end"]>["reason"];

export function createHistoryCapture(id: string, enqueue: (dialogue: Dialogue) => void) {
  const pendingSessions: HistorySession[] = [];
  let hasUtterance = false;

  function save(sessions: HistorySession[]): void {
    const snapshot: Dialogue = {
      schemaVersion: 1,
      id,
      sessions: sessions.map((session) => ({ ...session })),
    };
    enqueue(snapshot);
  }

  return {
    openSession() {
      let session: HistorySession | undefined;
      let start = 0;
      let sequence = 0;

      function connect(): HistorySession {
        if (!session) {
          start = performance.now();
          session = {
            id: crypto.randomUUID(),
            startedAt: new Date().toISOString(),
            end: null,
            messages: [],
          };
          if (!hasUtterance) pendingSessions.push(session);
        }
        return session;
      }

      return {
        connected(): void {
          if (session) return;
          const current = connect();
          if (hasUtterance) save([current]);
        },
        record(event: PipelineEvent): void {
          if (event.type !== "stt-result" && event.type !== "agent-reply") return;
          const text = event.type === "stt-result" ? event.result.text : event.text;
          if (!text.trim()) return;
          const current = connect();
          const message: HistorySession["messages"][number] = {
            seq: ++sequence,
            speaker: event.type === "stt-result" ? "user" : "agent",
            text,
            atMs: Math.round(performance.now() - start),
          };
          const earlierSessions = pendingSessions.splice(0).filter((entry) => entry !== current);
          hasUtterance = true;
          save([...earlierSessions, { ...current, messages: [message] }]);
        },
        finish(reason: EndReason): void {
          if (!session || session.end) return;
          session.end = { reason, durationMs: Math.round(performance.now() - start) };
          if (hasUtterance) save([session]);
        },
      };
    },
  };
}
