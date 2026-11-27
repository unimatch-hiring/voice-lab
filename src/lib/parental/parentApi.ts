import type { ContextLine, Flag, FlagCandidate, ParentSettings } from "./types";

/** Same origin: the dev server proxies `/api` to `server/` (see `vite.config.ts`). */
export const PARENT_API_URL = "/api";

export interface ParentApi {
  getSettings(): Promise<ParentSettings>;
  saveSettings(settings: ParentSettings): Promise<ParentSettings>;
  reviewFlag(candidate: FlagCandidate): Promise<{ flagged: boolean }>;
  listFlags(): Promise<Flag[]>;
  deleteChildData(): Promise<unknown>;
  appendTranscript(line: ContextLine): Promise<unknown>;
}

export class ParentApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`parental server ${path} failed: ${status}`);
    this.name = "ParentApiError";
  }
}

type FetchLike = typeof fetch;

export function createParentApi(
  baseUrl = PARENT_API_URL,
  // Looked up per call, so a test that spies on fetch after this is built still sees it.
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): ParentApi {
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new ParentApiError(path, r.status);
    return (await r.json()) as T;
  };

  return {
    getSettings: () => request("GET", "/settings"),
    saveSettings: (settings) => request("PUT", "/settings", settings),
    reviewFlag: (candidate) => request("POST", "/flags/review", candidate),
    listFlags: () => request("GET", "/flags"),
    deleteChildData: () => request("DELETE", "/child-data"),
    appendTranscript: (line) => request("POST", "/transcript", line),
  };
}
