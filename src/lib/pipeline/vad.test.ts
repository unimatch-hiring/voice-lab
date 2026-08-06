import { expect, test } from "vitest";
import { EnergyVad, rms } from "./vad";

const loud = () => Float32Array.from({ length: 128 }, () => 0.5);
const quiet = () => new Float32Array(128);

test("rms is zero for silence and positive for signal", () => {
  expect(rms(quiet())).toBe(0);
  expect(rms(loud())).toBeCloseTo(0.5, 5);
});

test("reports speech-start once when energy crosses the threshold", () => {
  const vad = new EnergyVad({ threshold: 0.1, hangoverFrames: 2 });

  expect(vad.push(quiet())).toBeNull();
  expect(vad.push(loud())).toBe("speech-start");
  expect(vad.push(loud())).toBeNull(); // уже говорим — второй раз не сообщаем
});

test("waits out the hangover before reporting speech-end", () => {
  const vad = new EnergyVad({ threshold: 0.1, hangoverFrames: 2 });
  vad.push(loud());

  expect(vad.push(quiet())).toBeNull(); // 1 тихий кадр — ещё рано
  expect(vad.push(quiet())).toBe("speech-end"); // 2 подряд — конец речи
});

test("a short pause inside speech does not end the turn", () => {
  const vad = new EnergyVad({ threshold: 0.1, hangoverFrames: 3 });
  vad.push(loud());

  vad.push(quiet());
  vad.push(quiet());
  expect(vad.push(loud())).toBeNull(); // вернулись к речи до истечения hangover
  expect(vad.push(quiet())).toBeNull();
});

test("reset returns the detector to the idle state", () => {
  const vad = new EnergyVad({ threshold: 0.1, hangoverFrames: 2 });
  vad.push(loud());
  vad.reset();

  expect(vad.push(loud())).toBe("speech-start");
});
