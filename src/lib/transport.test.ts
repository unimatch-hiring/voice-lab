import { expect, test, vi } from "vitest";
import { createTransport } from "./transport";

const config = { workerUrl: "https://worker.test", vibeToken: "vibe" };

test("sends the client token and asks the Worker for a session token", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ token: "sess", agentId: "agent_1" }), { status: 200 }),
  );

  const out = await createTransport(config, fetchImpl).agentToken();

  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe("https://worker.test/agent/token");
  expect(init.headers["x-vibe-token"], "the Worker gates on this").toBe("vibe");
  expect(out).toEqual({ token: "sess", agentId: "agent_1" });
});

test("surfaces a rejected token instead of returning nothing", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));

  await expect(createTransport(config, fetchImpl).agentToken()).rejects.toThrow(/401/);
});
