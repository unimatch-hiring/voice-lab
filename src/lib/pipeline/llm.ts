import type { Transport, LlmMessage } from "../transport";

export const SYSTEM_PROMPT =
  "Ты голосовой ассистент. Отвечай коротко — одно-два предложения, без списков " +
  "и markdown: твой ответ будет произнесён вслух. Отвечай на языке собеседника.";

export interface LlmDeps {
  transport: Transport;
  history?: LlmMessage[];
  systemPrompt?: string;
}

export async function* respond(userText: string, deps: LlmDeps): AsyncIterable<string> {
  const messages: LlmMessage[] = [
    { role: "system", content: deps.systemPrompt ?? SYSTEM_PROMPT },
    ...(deps.history ?? []),
    { role: "user", content: userText },
  ];

  yield* deps.transport.llmStream(messages);
}
