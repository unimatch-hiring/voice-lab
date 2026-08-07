import { expect, test, vi } from "vitest";
import { synthesize } from "./tts";
import type { WebSocketLike } from "./tts";

const transport = { ttsToken: async () => "tok" } as never;

/** Minimal websocket fake: replays a predefined set of server frames. */
function fakeSocket(frames: unknown[]): { factory: () => WebSocketLike; sent: string[] } {
  const sent: string[] = [];
  const factory = () => {
    const ws: WebSocketLike = {
      send: (d: string) => sent.push(d),
      close: () => {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => {
      ws.onopen?.();
      for (const f of frames) ws.onmessage?.({ data: JSON.stringify(f) });
      ws.onclose?.();
    });
    return ws;
  };
  return { factory, sent };
}

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

test("yields chunks with audio and character alignment", async () => {
  const { factory } = fakeSocket([
    {
      audio: b64([1, 0, 2, 0]),
      alignment: { chars: ["п", "р"], charStartTimesMs: [0, 50], charDurationsMs: [50, 50] },
    },
    { isFinal: true },
  ]);

  const out = [];
  for await (const c of synthesize("привет", { transport, socketFactory: factory })) out.push(c);

  expect(out).toHaveLength(1);
  expect(out[0].chars).toEqual(["п", "р"]);
  expect(out[0].charStartTimesMs).toEqual([0, 50]);
  expect(out[0].audio.length).toBe(2); // 4 bytes -> 2 Int16 samples
});

test("prefers normalizedAlignment when present", async () => {
  const { factory } = fakeSocket([
    {
      audio: b64([0, 0]),
      alignment: { chars: ["1"], charStartTimesMs: [0], charDurationsMs: [10] },
      normalizedAlignment: { chars: ["о", "д", "и", "н"], charStartTimesMs: [0, 5, 10, 15], charDurationsMs: [5, 5, 5, 5] },
    },
    { isFinal: true },
  ]);

  const out = [];
  for await (const c of synthesize("1", { transport, socketFactory: factory })) out.push(c);

  expect(out[0].chars).toEqual(["о", "д", "и", "н"]);
});

test("skips frames that carry no audio", async () => {
  const { factory } = fakeSocket([{ audio: null }, { isFinal: true }]);

  const out = [];
  for await (const c of synthesize("x", { transport, socketFactory: factory })) out.push(c);

  expect(out).toHaveLength(0);
});

test("skips a final frame that carries alignment but no audio", async () => {
  const { factory } = fakeSocket([
    {
      audio: b64([1, 0]),
      alignment: { chars: ["а"], charStartTimesMs: [0], charDurationsMs: [50] },
    },
    {
      audio: null,
      alignment: { chars: ["!"], charStartTimesMs: [50], charDurationsMs: [10] },
    },
    { isFinal: true },
  ]);

  const out = [];
  for await (const c of synthesize("а!", { transport, socketFactory: factory })) out.push(c);

  expect(out).toHaveLength(1);
  expect(out[0].chars).toEqual(["а"]);
});

test("authenticates the socket with single_use_token", async () => {
  // With `authorization=<token>` the socket closes with 1008 ("none of the
  // authentication methods were found") and no speech is ever produced. The
  // fixtures skip this socket entirely, so nothing else catches a regression here.
  const urls: string[] = [];
  const { factory } = fakeSocket([{ isFinal: true }]);
  const socketFactory = (u: string) => {
    urls.push(u);
    return factory();
  };

  for await (const _ of synthesize("hi", { transport, socketFactory })) {
    /* drain */
  }

  expect(urls[0]).toContain("single_use_token=tok");
  expect(urls[0]).not.toContain("authorization=");
});
