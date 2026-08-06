export interface AppConfig {
  workerUrl: string;
  vibeToken: string;
  /** Нет доступа к API — гоняем фикстуры. Собес это переживает. */
  offline: boolean;
}

export function loadConfig(): AppConfig {
  const workerUrl = import.meta.env.VITE_WORKER_URL ?? "";
  const vibeToken = import.meta.env.VITE_VIBE_TOKEN ?? "";

  return { workerUrl, vibeToken, offline: !workerUrl || !vibeToken };
}
