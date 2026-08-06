export interface TransportConfig {
  workerUrl: string;
  vibeToken: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Transport {
  sttToken(): Promise<string>;
  ttsToken(): Promise<string>;
  llmStream(messages: LlmMessage[]): AsyncIterable<string>;
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

  const token = async (type: string): Promise<string> => {
    const r = await post(`/token/${type}`);
    const data = (await r.json()) as { token: string };
    return data.token;
  };

  return {
    sttToken: () => token("batch_scribe"),
    ttsToken: () => token("tts_websocket"),

    async *llmStream(messages) {
      const r = await post("/llm", { messages });
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE-кадры разделены пустой строкой; последний фрагмент может быть неполным.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (delta) yield delta as string;
        }
      }
    },
  };
}
