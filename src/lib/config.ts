export interface AppConfig {
  workerUrl: string;
  vibeToken: string;
  /** Нет доступа к API — гоняем фикстуры. Собес это переживает. */
  offline: boolean;
}

const STORAGE_KEY = "voice-lab.byok";

export function loadConfig(): AppConfig {
  const workerUrl = import.meta.env.VITE_WORKER_URL ?? "";
  const envToken = import.meta.env.VITE_VIBE_TOKEN ?? "";
  // В публичной сборке токен вводит пользователь и он живёт в localStorage.
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  const vibeToken = envToken || stored || "";

  return { workerUrl, vibeToken, offline: !workerUrl || !vibeToken };
}

export function saveToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}
