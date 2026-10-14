import type { Engine } from "./pipeline/session";

export interface TransportConfig {
  workerUrl: string;
  vibeToken: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Transport {
  /** Session token for ElevenLabs Agents; the API key stays in the Worker. */
  agentToken(): Promise<{ token: string; agentId: string }>;
  /** Short-lived Deepgram grant; it only has to be valid while the socket opens. */
  deepgramToken(): Promise<{ token: string }>;
  /** Which engine this key was set to in the admin page. */
  engine(): Promise<Engine>;
}

type FetchLike = typeof fetch;

export function createTransport(cfg: TransportConfig, fetchImpl: FetchLike = fetch): Transport {
  const post = async (path: string, body?: unknown): Promise<Response> => {
    const r = await fetchImpl(`${cfg.workerUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibe-token": cfg.vibeToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`token-minter ${path} failed: ${r.status}`);
    return r;
  };


  return {
    /** Session token for ElevenLabs Agents, minted by the Worker. */
    agentToken: async () => {
      const r = await post("/agent/token");
      return (await r.json()) as { token: string; agentId: string };
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
