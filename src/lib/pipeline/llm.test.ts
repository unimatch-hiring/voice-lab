import { expect, test, vi } from "vitest";
import type { LlmMessage } from "../transport";
import { respond, SYSTEM_PROMPT } from "./llm";

function transportYielding(tokens: string[]) {
  const llmStream = vi.fn(async function* (_messages: LlmMessage[]) {
    for (const t of tokens) yield t;
  });
  return { transport: { llmStream } as never, llmStream };
}

test("streams tokens through unchanged", async () => {
  const { transport } = transportYielding(["При", "вет"]);

  const out: string[] = [];
  for await (const t of respond("хай", { transport })) out.push(t);

  expect(out).toEqual(["При", "вет"]);
});

test("sends the system prompt first and the user text last", async () => {
  const { transport, llmStream } = transportYielding([]);

  for await (const _ of respond("хай", { transport })) { /* drain */ }

  const messages = llmStream.mock.calls[0][0];
  expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  expect(messages[messages.length - 1]).toEqual({ role: "user", content: "хай" });
});

test("keeps prior history between the system prompt and the new turn", async () => {
  const { transport, llmStream } = transportYielding([]);
  const history = [
    { role: "user" as const, content: "первый вопрос" },
    { role: "assistant" as const, content: "первый ответ" },
  ];

  for await (const _ of respond("второй вопрос", { transport, history })) { /* drain */ }

  const messages = llmStream.mock.calls[0][0];
  expect(messages).toHaveLength(4);
  expect(messages[1]).toEqual(history[0]);
  expect(messages[2]).toEqual(history[1]);
});
