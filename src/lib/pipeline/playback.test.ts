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

  q.enqueue(chunk(16000)); // ровно 1 секунда при 16 кГц

  expect(started).toEqual([5]);
});

test("schedules each next chunk right after the previous one ends", () => {
  const { ctx, started } = fakeContext(0);
  const q = new PlaybackQueue(ctx as never);

  q.enqueue(chunk(16000)); // 1.0 c
  q.enqueue(chunk(8000)); // 0.5 c

  expect(started).toEqual([0, 1]);
});

test("does not rewind when the context clock has moved past the queue", () => {
  const { ctx, started } = fakeContext(0);
  const q = new PlaybackQueue(ctx as never);

  q.enqueue(chunk(16000));
  ctx.currentTime = 10; // очередь опустела, время ушло далеко вперёд
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
