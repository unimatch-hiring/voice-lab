import { historyBaseUrl, type Dialogue } from "./historyApi";

export interface PendingHistoryWrite {
  id: string;
  order: number;
  dialogue: Dialogue;
}

function writePrefix(): string {
  return `voice-lab:history-pending:${encodeURIComponent(historyBaseUrl())}:`;
}

function parseWrite(value: string, id: string): PendingHistoryWrite | undefined {
  try {
    const write: Partial<PendingHistoryWrite> | null = JSON.parse(value);
    if (
      write?.id === id &&
      typeof write.order === "number" &&
      Number.isSafeInteger(write.order) &&
      write.dialogue?.schemaVersion === 1 &&
      typeof write.dialogue.id === "string" &&
      Array.isArray(write.dialogue.sessions)
    ) {
      return { id, order: write.order, dialogue: write.dialogue };
    }
  } catch {
    return undefined;
  }
}

export function readPendingHistoryWrites() {
  const prefix = writePrefix();
  const writes: PendingHistoryWrite[] = [];
  let incomplete = false;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    const value = localStorage.getItem(key);
    if (value === null) continue;
    const write = parseWrite(value, key.slice(prefix.length));
    if (write) writes.push(write);
    else incomplete = true;
  }
  writes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { writes, incomplete };
}

export function persistPendingHistoryWrite(write: PendingHistoryWrite): void {
  // Separate keys let tabs acknowledge writes without replacing each other's pending data.
  localStorage.setItem(writePrefix() + write.id, JSON.stringify(write));
}

export function removePendingHistoryWrite(id: string): void {
  localStorage.removeItem(writePrefix() + id);
}
