export interface AppConfig {
  workerUrl: string;
  vibeToken: string;
  /** No token: nothing can run. */
  offline: boolean;
  /** The local history server; null where history is off. */
  historyUrl: string | null;
}

/**
 * Deployed token-minter. A default rather than a required build variable, so a plainly
 * started dev server still reaches it. The address is not a secret — the Worker is gated
 * by its origin list and by the token.
 */
const DEFAULT_WORKER_URL = "https://voice-lab-token-minter.shupilkin.workers.dev";

// The server is local only (`npm run server`), so only a dev build talks to it unless the variable says otherwise.
const DEFAULT_LOCAL_HISTORY_URL = "http://localhost:8788";

/** The build variables `loadConfig` reads; a plain object in tests. */
type ConfigEnv = Partial<
  Pick<ImportMetaEnv, "VITE_WORKER_URL" | "VITE_VIBE_TOKEN" | "VITE_HISTORY_URL" | "DEV">
>;

/**
 * The published build ships without a token on purpose: baking one in would hand our
 * paid quota to every visitor. On the deployed site the token is pasted into the page
 * and kept in IndexedDB (see `tokenStore.ts`), so live mode needs no rebuild.
 */
export function loadConfig(storedToken = "", env: ConfigEnv = import.meta.env): AppConfig {
  const workerUrl = env.VITE_WORKER_URL ?? DEFAULT_WORKER_URL;
  const vibeToken = env.VITE_VIBE_TOKEN ?? storedToken;
  // A trailing slash would make every request path start with "//" and miss the routes.
  const historyUrl =
    env.VITE_HISTORY_URL?.replace(/\/+$/, "") || (env.DEV ? DEFAULT_LOCAL_HISTORY_URL : null);

  return { workerUrl, vibeToken, offline: !workerUrl || !vibeToken, historyUrl };
}
