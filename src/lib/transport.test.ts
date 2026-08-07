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

// A frame can arrive split across two read() calls — the only non-trivial logic
// in the module (carrying the incomplete tail over in the buffer).
function chunkedResponse(body: string, cutAt: number): Response {
  const enc = new TextEncoder();
  const parts = [body.slice(0, cutAt), body.slice(cutAt)];
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (i < parts.length) controller.enqueue(enc.encode(parts[i++]));
        else controller.close();
      },
    }),
    { status: 200 },
  );
}

test("llmStream yields the last token even when the stream ends without [DONE] or a trailing blank line", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"вет"}}]}', // cut off: no \n\n and no [DONE]
  ].join("");
  const fetchMock = vi.fn().mockResolvedValue(new Response(sse, { status: 200 }));
  const t = createTransport(cfg, fetchMock);

  const out: string[] = [];
  for await (const token of t.llmStream([{ role: "user", content: "hi" }])) out.push(token);

  expect(out).toEqual(["При", "вет"]);
});

test("llmStream reassembles an SSE frame split across two stream chunks", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"вет"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const cutAt = sse.indexOf('"вет"'); // cut inside the second frame

  const fetchMock = vi.fn().mockResolvedValue(chunkedResponse(sse, cutAt));
  const t = createTransport(cfg, fetchMock);

  const out: string[] = [];
  for await (const token of t.llmStream([{ role: "user", content: "hi" }])) out.push(token);

  expect(out).toEqual(["При", "вет"]);
});
