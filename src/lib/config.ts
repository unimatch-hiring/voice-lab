export interface AppConfig {
  workerUrl: string;
  vibeToken: string;
  /** No token: nothing can run. */
  offline: boolean;
}

/**
 * Deployed token-minter. A default rather than a required build variable, so a plainly
 * started dev server still reaches it. The address is not a secret — the Worker is gated
 * by its origin list and by the token.
 */
const DEFAULT_WORKER_URL = "https://voice-lab-token-minter.shupilkin.workers.dev";

/**
 * The published build ships without a token on purpose: baking one in would hand our
 * paid quota to every visitor. On the deployed site the token is pasted into the page
 * and kept in IndexedDB (see `tokenStore.ts`), so live mode needs no rebuild.
 */
export function loadConfig(storedToken = ""): AppConfig {
  const workerUrl = import.meta.env.VITE_WORKER_URL ?? DEFAULT_WORKER_URL;
  const vibeToken = import.meta.env.VITE_VIBE_TOKEN ?? storedToken;

  return { workerUrl, vibeToken, offline: !workerUrl || !vibeToken };
}
