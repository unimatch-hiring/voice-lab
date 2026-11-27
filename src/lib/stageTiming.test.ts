import { describe, expect, it } from "vitest";
import { slowestStage } from "./stageTiming";

describe("slowestStage", () => {
  it("names the stage with the largest time", () => {
    expect(slowestStage({ vad: 200, stt: 300, llm: 700, tts: 150 }, ["vad", "stt", "llm", "tts"])).toBe(
      "llm",
    );
  });

  it("keeps the first stage in order on a tie", () => {
    const stages = { stt: 400, llm: 400 };
    expect(slowestStage(stages, ["stt", "llm"])).toBe("stt");
    expect(slowestStage(stages, ["llm", "stt"])).toBe("llm");
  });

  it("is null when no stage in order was measured", () => {
    expect(slowestStage({}, ["stt", "llm"])).toBeNull();
    expect(slowestStage({ tts: 100 }, ["stt", "llm"])).toBeNull();
  });

  it("ignores a stage outside order, however slow", () => {
    expect(slowestStage({ stt: 100, llm: 200, playback: 9000 }, ["stt", "llm"])).toBe("llm");
  });

  it("counts a measured zero", () => {
    expect(slowestStage({ stt: 0 }, ["stt", "llm"])).toBe("stt");
  });
});
