import { once } from "node:events";
import { renameSync, unlinkSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createHistoryServer } from "../../server/index.js";
import { readDialogue } from "./historyApi";
import { createHistoryWriteQueue } from "./historyWriteQueue";

test("[TC-012] the queue automatically retries a failed HTTP save and preserves both utterances", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-lab-queue-"));
  const dataDir = join(root, "history");
  const backup = join(root, "saved-history");
  const server = createHistoryServer({ dataDir });
  const putStatuses = [];
  server.on("request", (request, response) => {
    if (request.method === "PUT") response.once("finish", () => putStatuses.push(response.statusCode));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  vi.stubEnv("VITE_HISTORY_URL", `http://127.0.0.1:${server.address().port}`);
  const queue = createHistoryWriteQueue(() => {});
  const session = { id: "session", startedAt: "2026-11-19T10:00:00.000Z", end: null };
  function enqueue(message) {
    queue.enqueue({ id: "dialogue", schemaVersion: 1, sessions: [{ ...session, messages: [message] }] });
  }

  try {
    queue.start();
    enqueue({ seq: 1, speaker: "user", text: "Can you hear me?", atMs: 100 });
    await vi.waitFor(() => expect(putStatuses).toEqual([204]));

    // A file in place of the data directory makes the real save fail, even when running as root.
    await rename(dataDir, backup);
    await writeFile(dataDir, "Storage unavailable");
    server.once("request", (_request, response) => {
      response.once("finish", () => {
        unlinkSync(dataDir);
        renameSync(backup, dataDir);
      });
    });
    enqueue({ seq: 2, speaker: "agent", text: "Yes, I can.", atMs: 500 });
    await vi.waitFor(() => expect(putStatuses).toEqual([204, 500, 204]), { timeout: 4_000 });

    const dialogue = await readDialogue("dialogue");
    expect(dialogue.sessions.flatMap((s) => s.messages.map((m) => m.text)))
      .toEqual(["Can you hear me?", "Yes, I can."]);
  } finally {
    queue.stop();
    vi.unstubAllEnvs();
    localStorage.clear();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
