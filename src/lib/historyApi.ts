export type EndReason = "user" | "agent" | "error";
export const historySavedEvent = "voice-lab-history-saved";

export interface Utterance {
  seq: number;
  speaker: "user" | "agent";
  text: string;
  atMs: number;
}

export interface DialogueSession {
  id: string;
  startedAt: string;
  end: { reason: EndReason; durationMs: number } | null;
  messages: Utterance[];
}

export interface Dialogue {
  schemaVersion: 1;
  id: string;
  sessions: DialogueSession[];
}

export interface DialogueSummary {
  id: string;
  startedAt: string;
  durationMs: number;
  endReason: EndReason | null;
}

export interface HistoryListing {
  dialogues: DialogueSummary[];
  incomplete: boolean;
}

export class HistoryApiError extends Error {
  constructor(readonly status: number) {
    super(`History request failed (${status})`);
  }
}

export function historyBaseUrl(): string {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const base = import.meta.env.VITE_HISTORY_URL?.trim() || (local ? "http://127.0.0.1:8788" : "");
  if (!base) return "";
  return new URL(base, location.origin).href.replace(/\/+$/, "");
}

async function historyRequest(path: string, options?: RequestInit): Promise<Response> {
  const base = historyBaseUrl();
  if (!base) throw new Error("History server URL is missing");
  const response = await fetch(`${base}${path}`, options);
  if (!response.ok) throw new HistoryApiError(response.status);
  return response;
}

function dialoguePath(id: string): string {
  return `/dialogues/${encodeURIComponent(id)}`;
}

export async function listDialogues(signal?: AbortSignal): Promise<HistoryListing> {
  const response = await historyRequest("/dialogues", { signal });
  const dialogues: DialogueSummary[] = await response.json();
  return { dialogues, incomplete: response.headers.get("X-History-Incomplete") === "1" };
}

export async function readDialogue(id: string, signal?: AbortSignal): Promise<Dialogue> {
  const response = await historyRequest(dialoguePath(id), { signal });
  return response.json();
}

export async function saveDialogue(dialogue: Dialogue, signal?: AbortSignal): Promise<void> {
  await historyRequest(dialoguePath(dialogue.id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(dialogue),
    signal,
  });
  window.dispatchEvent(new Event(historySavedEvent));
}

export async function deleteDialogue(id: string): Promise<void> {
  await historyRequest(dialoguePath(id), { method: "DELETE" });
}
