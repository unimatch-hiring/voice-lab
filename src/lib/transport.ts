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
  /**
   * A signed WebSocket URL for the same agent.
   *
   * The side layers run as text-only sessions, and `textOnly` puts the SDK on its
   * WebSocket transport, which the WebRTC conversation token above cannot authenticate.
   */
  signedUrl(): Promise<{ signedUrl: string }>;
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
    signedUrl: async () => {
      const r = await post("/agent/signed-url");
      return (await r.json()) as { signedUrl: string };
    },

  };
}
