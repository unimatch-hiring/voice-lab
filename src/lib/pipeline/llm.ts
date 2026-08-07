import type { Transport, LlmMessage } from "../transport";

/**
 * Kept language-neutral on purpose: the reply must follow whatever language the
 * speaker used, so the prompt states that rather than being written in one.
 */
export const SYSTEM_PROMPT =
  "You are a voice assistant. Keep answers short — one or two sentences, no lists " +
  "and no markdown: your reply will be spoken aloud. Always answer in the same " +
  "language the user spoke.";

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
