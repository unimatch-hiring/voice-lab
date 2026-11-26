import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createChildService, EMPTY_DOC } from "./childService.js";
import { createJsonStore } from "./jsonStore.js";

const DATA_FILE = fileURLToPath(new URL("./data/db.json", import.meta.url));
const PORT = Number(process.env.PORT ?? 8790);

const service = createChildService(createJsonStore(DATA_FILE, EMPTY_DOC));

createServer(createApp(service)).listen(PORT, () => {
  console.log(`parental server on http://localhost:${PORT}, data in ${DATA_FILE}`);
});
