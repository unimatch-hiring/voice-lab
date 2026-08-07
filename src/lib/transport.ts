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

      // null = not a data frame, "done" = end of stream, otherwise a token.
      const parseFrame = (frame: string): string | null | "done" => {
        const line = frame.trim();
        if (!line.startsWith("data:")) return null;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return "done";
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        return delta ? (delta as string) : null;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; the last piece may be incomplete.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const parsed = parseFrame(frame);
          if (parsed === "done") return;
          if (parsed) yield parsed;
        }
      }

      // The stream may have ended without [DONE] and without a trailing \n\n — parse the leftover buffer the same way.
      const tail = parseFrame(buffer);
      if (tail && tail !== "done") yield tail;
    },
  };
}
