import { isChildProfile, isUuid, REQUEST_BODY_LIMIT, REVIEW_TURN_LIMIT, type ChildProfile, type TurnReview } from "../../shared/child";
import type { Engine } from "./pipeline/session";

export interface TransportConfig {
  workerUrl: string;
  vibeToken: string;
  childServerUrl: string;
}

export interface Transport {
  /** Session token for ElevenLabs Agents; the API key stays in the Worker. */
  agentToken(): Promise<{ token: string; agentId: string }>;
  childProfile(childId: string): Promise<ChildProfile>;
  startChildConversation(childId: string, rulesVersion: number): Promise<{ conversationId: string }>;
  reviewTurn(review: TurnReview): Promise<void>;
  endChildConversation(childId: string, conversationId: string, status: "ended" | "failed"): Promise<void>;
  /** Short-lived Deepgram grant; it only has to be valid while the socket opens. */
  deepgramToken(): Promise<{ token: string }>;
  /** Which engine this key was set to in the admin page. */
  engine(): Promise<Engine>;
}

type FetchLike = typeof fetch;

/** The Worker answered, but not with 2xx: the status says whose fault it was. */
export class WorkerError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`token-minter ${path} failed: ${status}`);
    this.name = "WorkerError";
  }
}

export class ChildServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildServerError";
  }
}

export function createTransport(cfg: TransportConfig, fetchImpl: FetchLike = fetch): Transport {
  const post = async (path: string, body?: unknown): Promise<Response> => {
    const r = await fetchImpl(`${cfg.workerUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibe-token": cfg.vibeToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new WorkerError(path, r.status);
    return r;
  };

  function childUrl(path: string) {
    if (!cfg.childServerUrl) throw new ChildServerError("The child profile server is not configured.");
    try {
      return new URL(path, cfg.childServerUrl);
    } catch {
      throw new ChildServerError("The child profile server URL is invalid.");
    }
  }

  function postChild(path: string, body: string, timeout: number) {
    return fetchImpl(childUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
  }

  return {
    /** Session token for ElevenLabs Agents, minted by the Worker. */
    agentToken: async () => {
      const r = await post("/agent/token");
      return (await r.json()) as { token: string; agentId: string };
    },

    childProfile: async (childId) => {
      const url = childUrl("/profile");
      url.searchParams.set("childId", childId);
      const response = await fetchImpl(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (response?.status === 404) throw new ChildServerError("This child profile was not found. Ask for a new link.");
      const profile: unknown = response?.ok ? await response.json().catch(() => null) : null;
      if (isChildProfile(profile)) return profile;
      throw new ChildServerError("Could not load the child profile. Check the profile server and try again.");
    },

    startChildConversation: async (childId, rulesVersion) => {
      const body = JSON.stringify({ childId, rulesVersion });
      const response = await postChild("/api/child/conversations", body, 5000).catch(() => null);
      if (!response?.ok) {
        throw new ChildServerError("Could not register the child conversation for review. Check the profile server and try again.");
      }
      const result: { conversationId?: unknown } | null = await response.json().catch(() => null);
      const conversationId = result?.conversationId;
      if (!isUuid(conversationId)) throw new ChildServerError("The profile server returned an invalid conversation ID.");
      return { conversationId };
    },

    reviewTurn: async (review) => {
      const encoder = new TextEncoder();
      let turns = review.turns.slice(-REVIEW_TURN_LIMIT);
      let body = JSON.stringify({ ...review, turns });
      while (turns.length > 1 && encoder.encode(body).byteLength > REQUEST_BODY_LIMIT) {
        turns = turns.slice(1);
        body = JSON.stringify({ ...review, turns });
      }
      const path = "/api/child/turn-reviews";
      let response = await postChild(path, body, 15000).catch(() => null);
      if (!response || [429, 500, 502, 504].includes(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        response = await postChild(path, body, 15000);
      }
      if (!response.ok) throw new Error("Turn review failed: HTTP " + response.status);
    },

    endChildConversation: async (childId, conversationId, status) => {
      const path = "/api/child/conversations/" + encodeURIComponent(conversationId) + "/end";
      const response = await postChild(path, JSON.stringify({ childId, status }), 5000);
      if (!response.ok) throw new Error("Conversation ending failed: HTTP " + response.status);
    },

    deepgramToken: async () => {
      const r = await post("/deepgram-token");
      return (await r.json()) as { token: string };
    },

    engine: async () => {
      const r = await post("/engine");
      const { engine } = (await r.json()) as { engine?: string };
      return engine === "deepgram" ? "deepgram" : "elevenlabs";
    },
  };
}
