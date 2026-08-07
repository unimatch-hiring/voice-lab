import { expect, test, vi } from "vitest";
import { transcribe } from "./stt";

const scribeResponse = {
  text: "привет мир",
  words: [
    { text: "привет", start: 0.0, end: 0.5, logprob: -0.1 },
    { text: "мир", start: 0.6, end: 0.9, logprob: -2.5 },
  ],
};

const transport = { sttToken: async () => "tok" } as never;

test("sends language_code=rus by default", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(scribeResponse), { status: 200 }),
  );

  await transcribe(new Blob(["x"]), { transport, fetchImpl });

  const body = fetchImpl.mock.calls[0][1].body as FormData;
  expect(body.get("language_code")).toBe("rus");
  expect(body.get("timestamps_granularity")).toBe("word");
});

test("normalizes words and derives confidence from logprob", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(scribeResponse), { status: 200 }),
  );

  const out = await transcribe(new Blob(["x"]), { transport, fetchImpl });

  expect(out.text).toBe("привет мир");
  expect(out.words).toHaveLength(2);
  expect(out.words[0].confidence).toBeGreaterThan(out.words[1].confidence);
  expect(out.words[0].confidence).toBeLessThanOrEqual(1);
  expect(out.words[1].confidence).toBeGreaterThanOrEqual(0);
});

test("surfaces upstream failure as a readable error", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));

  await expect(transcribe(new Blob(["x"]), { transport, fetchImpl })).rejects.toThrow(/500/);
});

test("clamps confidence to 1 when the provider returns a non-negative logprob", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        text: "да",
        words: [{ text: "да", start: 0, end: 0.2, logprob: 0.5 }],
      }),
      { status: 200 },
    ),
  );

  const out = await transcribe(new Blob(["x"]), { transport, fetchImpl });

  expect(out.words[0].confidence).toBe(1);
});

test("passes the single-use token in the query string, not a header", async () => {
  // Scribe answers 401 to `authorization: Bearer <sutkn_...>` and to `xi-api-key`.
  // Live transcription was broken this way while every fixture test stayed green,
  // because the fixtures never reach this call.
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(scribeResponse), { status: 200 }),
  );

  await transcribe(new Blob(["x"]), { transport, fetchImpl });

  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toContain("token=tok");
  expect(init.headers ?? {}).not.toHaveProperty("authorization");
});
