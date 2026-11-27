// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createOpenAiClassifier } from "./llmClassifier.js";

const CANDIDATE = {
  text: "Папа опять меня бьёт, когда мама на работе",
  parentConcerns: "дядя Вася",
  context: [{ role: "assistant", text: "Как прошёл твой день?" }],
  agentReply: "Мне очень жаль, ты сейчас в безопасности?",
};
const VERDICT = { concern: true, category: "abuse", severity: "high", reason: "Ребёнок говорит о побоях." };

const answering = (content, status = 200) =>
  vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      status,
    }),
  );

describe("OpenAI classifier", () => {
  it("returns the model's verdict", async () => {
    const fetchImpl = answering(VERDICT);
    const classifier = createOpenAiClassifier({ apiKey: "sk-test", model: "gpt-test", fetchImpl });

    expect(await classifier.classify(CANDIDATE)).toEqual(VERDICT);
  });

  it("sends the child's full message, the context and a strict schema", async () => {
    const fetchImpl = answering(VERDICT);
    await createOpenAiClassifier({ apiKey: "sk-test", model: "gpt-test", fetchImpl }).classify(CANDIDATE);

    const [url, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-test");
    expect(body.model).toBe("gpt-test");
    expect(body.messages[1].content).toContain(CANDIDATE.text);
    expect(JSON.parse(body.messages[1].content).earlier_lines_for_context_only).toEqual(CANDIDATE.context);
    expect(body.messages[0].content).toMatch(/judge only child_message/i);
    expect(body.messages[1].content).toContain(CANDIDATE.agentReply);
    expect(body.messages[1].content).toContain("дядя Вася");
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it("talks to another OpenAI-compatible API when given its address", async () => {
    const fetchImpl = answering(VERDICT);
    await createOpenAiClassifier({
      apiKey: "sk-or-test",
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
      fetchImpl,
    }).classify(CANDIDATE);

    expect(fetchImpl.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("throws instead of guessing when OpenAI fails", async () => {
    const classifier = createOpenAiClassifier({
      apiKey: "sk-test",
      model: "gpt-test",
      fetchImpl: answering({}, 500),
    });

    await expect(classifier.classify(CANDIDATE)).rejects.toThrow(/500/);
  });

  it("throws on a verdict outside the schema", async () => {
    const classifier = createOpenAiClassifier({
      apiKey: "sk-test",
      model: "gpt-test",
      fetchImpl: answering({ ...VERDICT, category: "made_up" }),
    });

    await expect(classifier.classify(CANDIDATE)).rejects.toThrow(/unexpected shape/);
  });

  it("never hands back a concern labelled none", async () => {
    const classifier = createOpenAiClassifier({
      apiKey: "sk-test",
      model: "gpt-test",
      fetchImpl: answering({ ...VERDICT, category: "none", severity: "none" }),
    });

    expect(await classifier.classify(CANDIDATE)).toMatchObject({
      concern: true,
      category: "other",
      severity: "medium",
    });
  });

  it.each([
    ["a refusal", { choices: [{ message: { content: null, refusal: "I can't help" } }] }, /can't help/],
    ["no answer at all", { choices: [] }, /no verdict/],
    ["text that is not JSON", { choices: [{ message: { content: "concern: yes" } }] }, /JSON/],
  ])("throws on %s instead of guessing", async (_, body, error) => {
    const classifier = createOpenAiClassifier({
      apiKey: "sk-test",
      model: "gpt-test",
      fetchImpl: async () => new Response(JSON.stringify(body)),
    });

    await expect(classifier.classify(CANDIDATE)).rejects.toThrow(error);
  });

  it("throws when the network fails", async () => {
    const classifier = createOpenAiClassifier({
      apiKey: "sk-test",
      model: "gpt-test",
      fetchImpl: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });

    await expect(classifier.classify(CANDIDATE)).rejects.toThrow(/timed out/);
  });

  it("does not call OpenAI without a key", async () => {
    const fetchImpl = answering(VERDICT);

    await expect(
      createOpenAiClassifier({ apiKey: "", model: "gpt-test", fetchImpl }).classify(CANDIDATE),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
