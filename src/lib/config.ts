export interface AppConfig {
  workerUrl: string;
  vibeToken: string;
  /** No API access — replay the recorded fixtures. */
  offline: boolean;
}

/**
 * The published build ships without a token on purpose: baking one in would hand
 * our paid quota to every visitor. A build-time token still works for local runs
 * and CI, but on the deployed site the token is pasted into the page and kept in
 * IndexedDB (see `tokenStore.ts`), so the live pipeline runs without a rebuild.
 */
export function loadConfig(storedToken = ""): AppConfig {
  const workerUrl = import.meta.env.VITE_WORKER_URL ?? "";
  const vibeToken = import.meta.env.VITE_VIBE_TOKEN ?? storedToken;

  return { workerUrl, vibeToken, offline: !workerUrl || !vibeToken };
}
