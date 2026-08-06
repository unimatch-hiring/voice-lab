import { expect, test, vi } from "vitest";
import { createTransport } from "./transport";

const cfg = { workerUrl: "https://w.example", vibeToken: "t" };

test("requests a scribe token and returns it", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ token: "abc" }), { status: 200 }),
  );
  const t = createTransport(cfg, fetchMock);

  await expect(t.sttToken()).resolves.toBe("abc");

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://w.example/token/batch_scribe");
  expect(init.headers["x-vibe-token"]).toBe("t");
});

test("throws a readable error when the worker rejects us", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
  const t = createTransport(cfg, fetchMock);

  await expect(t.sttToken()).rejects.toThrow(/401/);
});

test("llmStream yields tokens parsed out of the SSE body", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"вет"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const fetchMock = vi.fn().mockResolvedValue(new Response(sse, { status: 200 }));
  const t = createTransport(cfg, fetchMock);

  const out: string[] = [];
  for await (const token of t.llmStream([{ role: "user", content: "hi" }])) out.push(token);

  expect(out).toEqual(["При", "вет"]);
});
