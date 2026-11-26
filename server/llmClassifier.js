const OPENAI_BASE_URL = "https://api.openai.com/v1";
// Generous: the review runs off the conversation path, so a slow answer blocks nothing.
const TIMEOUT_MS = 30_000;

export const CATEGORIES = ["self_harm", "abuse", "neglect", "violence", "sexual", "bullying", "danger", "other", "none"];
export const SEVERITIES = ["low", "medium", "high", "none"];

const INSTRUCTIONS = `You review messages a child said to a voice assistant, for their parent.
Every message the child says reaches you; most are harmless (games, films,
jokes, figures of speech). Decide whether the child may actually be at risk or in distress:
self-harm, abuse, neglect (left alone, hungry, cold), violence against or by the child, sexual
content, bullying, or other danger. Take the parent's concerns into account when given.
Judge only child_message, the latest thing the child said. Earlier lines were reviewed when
they were said: use them only to understand what child_message means, never as a reason to
flag it. A message that is harmless on its own ("we played football", "yes, I'm here", "it's
fine, they came back") is not a concern, whatever was said before it. When unsure about
child_message itself, prefer flagging a real risk over missing one. When concern is true,
category and severity are never "none".
Write the reason in one short sentence, in the language of the message.`;

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["concern", "category", "severity", "reason"],
  properties: {
    concern: { type: "boolean" },
    category: { type: "string", enum: CATEGORIES },
    severity: { type: "string", enum: SEVERITIES },
    reason: { type: "string" },
  },
};

/**
 * Decides whether a keyword match is a real concern. Throws when it cannot decide.
 * Any OpenAI-compatible API works, e.g. OpenRouter with `baseUrl: "https://openrouter.ai/api/v1"`.
 */
export function createOpenAiClassifier({ apiKey, model, baseUrl = OPENAI_BASE_URL, fetchImpl = fetch }) {
  return {
    async classify({ text, context, agentReply, parentConcerns }) {
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

      const r = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: INSTRUCTIONS },
            {
              role: "user",
              content: JSON.stringify({
                child_message: text,
                earlier_lines_for_context_only: context,
                assistant_reply: agentReply ?? null,
                parent_concerns: parentConcerns || null,
              }),
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "child_safety_review", strict: true, schema: VERDICT_SCHEMA },
          },
        }),
      });
      if (!r.ok) throw new Error(`OpenAI answered ${r.status}`);

      const message = (await r.json()).choices?.[0]?.message;
      if (!message?.content) throw new Error(message?.refusal ?? "OpenAI returned no verdict");
      return parseVerdict(JSON.parse(message.content));
    },
  };
}

function parseVerdict(v) {
  if (
    typeof v?.concern !== "boolean" ||
    !CATEGORIES.includes(v.category) ||
    !SEVERITIES.includes(v.severity) ||
    typeof v.reason !== "string"
  ) {
    throw new Error("OpenAI verdict has an unexpected shape");
  }
  // The schema cannot tie category to concern, and models do answer "concern, category none":
  // the parent must never see a flag labelled "none · none".
  if (v.concern) {
    return {
      concern: true,
      category: v.category === "none" ? "other" : v.category,
      severity: v.severity === "none" ? "medium" : v.severity,
      reason: v.reason,
    };
  }
  return { concern: false, category: v.category, severity: v.severity, reason: v.reason };
}
