import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createChildService, EMPTY_DOC } from "./childService.js";
import { createJsonStore } from "./jsonStore.js";
import { createOpenAiClassifier } from "./llmClassifier.js";

const DATA_FILE = fileURLToPath(new URL("./data/db.json", import.meta.url));
const PORT = Number(process.env.PORT ?? 8790);

// The provider is chosen here only; the service sees nothing but `classify`.
const classifier = createOpenAiClassifier({
  apiKey: process.env.OPENAI_API_KEY,
  // OpenRouter is our provider; the classifier speaks the OpenAI-compatible API it exposes.
  model: process.env.OPENAI_MODEL ?? "typesafe/jev-router",
  baseUrl: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
});
const service = createChildService(createJsonStore(DATA_FILE, EMPTY_DOC), classifier);

createServer(createApp(service)).listen(PORT, () => {
  console.log(`parental server on http://localhost:${PORT}, data in ${DATA_FILE}`);
  if (!process.env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY is not set: every flag stays unverified");
});
