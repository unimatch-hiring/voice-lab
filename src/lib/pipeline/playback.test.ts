import { expect, test, vi } from "vitest";
import { PlaybackQueue } from "./playback";
import type { TtsChunk } from "../types";

const chunk = (samples: number): TtsChunk => ({
  audio: new Int16Array(samples),
  chars: [],
  charStartTimesMs: [],
  charDurationsMs: [],
});

function fakeContext(currentTime = 0) {
  const started: number[] = [];
  return {
    started,
    ctx: {
      currentTime,
      sampleRate: 16000,
      createBuffer: (_ch: number, length: number, rate: number) => ({
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: () => new Float32Array(length),
      }),
      createBufferSource: () => ({
        buffer: null as unknown,
        connect: () => {},
        start: (at: number) => started.push(at),
        stop: () => {},
      }),
      destination: {},
    },
  };
}

test("schedules the first chunk at the current time", () => {
  const { ctx, started } = fakeContext(5);
  const q = new PlaybackQueue(ctx as never);

  q.enqueue(chunk(16000)); // exactly 1 second at 16 kHz

  expect(started).toEqual([5]);
});

test("schedules each next chunk right after the previous one ends", () => {
  const { ctx, started } = fakeContext(0);
  const q = new PlaybackQueue(ctx as never);

  q.enqueue(chunk(16000)); // 1.0 s
  q.enqueue(chunk(8000)); // 0.5 s

  expect(started).toEqual([0, 1]);
});

test("does not rewind when the context clock has moved past the queue", () => {
  const { ctx, started } = fakeContext(0);
  const q = new PlaybackQueue(ctx as never);

  q.enqueue(chunk(16000));
  ctx.currentTime = 10; // queue drained, the clock has moved far ahead
  q.enqueue(chunk(16000));

  expect(started).toEqual([0, 10]);
});

test("stop resets the queue so the next turn starts clean", () => {
  const { ctx, started } = fakeContext(0);
  const q = new PlaybackQueue(ctx as never);

  q.enqueue(chunk(16000));
  q.stop();
  ctx.currentTime = 3;
  q.enqueue(chunk(16000));

  expect(started).toEqual([0, 3]);
  expect(q.elapsedMs).toBe(0);
});

test("elapsedMs keeps counting from the first chunk, not the latest one", () => {
  const { ctx } = fakeContext(0);
  const q = new PlaybackQueue(ctx as never);

  q.enqueue(chunk(16000)); // starts at 0, lasts 1 s
  ctx.currentTime = 0.5;
  q.enqueue(chunk(16000)); // scheduled at 1, but the count runs from the first one

  ctx.currentTime = 1.5;
  expect(q.elapsedMs).toBe(1500);
});

test("stop clears the schedule so the next turn does not wait out the old one", () => {
  const { ctx, started } = fakeContext(0);
  const q = new PlaybackQueue(ctx as never);

  q.enqueue(chunk(160000)); // long chunk: 10 s
  ctx.currentTime = 2; // interrupted in the 2nd second
  q.stop();
  q.enqueue(chunk(16000));

  expect(started).toEqual([0, 2]); // without the reset it would be [0, 10]
});
