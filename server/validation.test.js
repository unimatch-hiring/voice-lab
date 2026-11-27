import { describe, expect, it } from "vitest";
import { ENDED_BY, MAX_ID_LENGTH } from "../shared/historyContract.js";
import { parseEntries, parseId, parseOpenBody } from "./validation.js";

const line = (overrides = {}) => ({
  kind: "line", seq: 1, speaker: "user", text: "hello", atMs: 0, ...overrides,
});
const metrics = (overrides = {}) => ({
  stages: { stt: 120.5, llm: 300 }, totalMs: 900, llmTokens: 42, ttsChars: 180, ...overrides,
});
const turn = (overrides = {}) => ({
  kind: "turn", seq: 1, atMs: 1000, metrics: metrics(), ...overrides,
});
const end = (overrides = {}) => ({ kind: "end", endedBy: "user", segment: 1, ...overrides });
const resume = (overrides = {}) => ({ kind: "resume", segment: 2, ...overrides });
const parse = (...entries) => parseEntries({ entries });

describe("parseId", () => {
  it("returns an id of 1 to MAX_ID_LENGTH characters", () => {
    expect(parseId("c1")).toBe("c1");
    expect(parseId("x".repeat(MAX_ID_LENGTH))).toBe("x".repeat(MAX_ID_LENGTH));
  });

  it.each([
    ["empty", ""],
    ["over the limit", "x".repeat(MAX_ID_LENGTH + 1)],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
  ])("returns null for %s", (_name, value) => {
    expect(parseId(value)).toBeNull();
  });
});

describe("parseOpenBody", () => {
  it("returns the two ids", () => {
    expect(parseOpenBody({ conversationId: "c1", agentId: "a1" })).toEqual({
      conversationId: "c1", agentId: "a1",
    });
  });

  it("accepts ids of exactly 200 characters", () => {
    const id = "x".repeat(200);
    expect(parseOpenBody({ conversationId: id, agentId: id })).toEqual({
      conversationId: id, agentId: id,
    });
  });

  it("drops extra fields", () => {
    expect(parseOpenBody({ conversationId: "c1", agentId: "a1", extra: 1 })).toEqual({
      conversationId: "c1", agentId: "a1",
    });
  });

  it.each([
    ["a non-object", "text"],
    ["null", null],
    ["an array", []],
    ["a missing conversationId", { agentId: "a1" }],
    ["a missing agentId", { conversationId: "c1" }],
    ["an empty conversationId", { conversationId: "", agentId: "a1" }],
    ["an empty agentId", { conversationId: "c1", agentId: "" }],
    ["a conversationId of 201 characters", { conversationId: "x".repeat(201), agentId: "a1" }],
    ["an agentId of 201 characters", { conversationId: "c1", agentId: "x".repeat(201) }],
    ["a numeric conversationId", { conversationId: 1, agentId: "a1" }],
  ])("rejects %s", (_name, body) => {
    expect(parseOpenBody(body)).toBeNull();
  });
});

describe("parseEntries", () => {
  describe("batch size", () => {
    it("accepts 1 and 50 entries", () => {
      expect(parse(line())).toHaveLength(1);
      expect(parseEntries({ entries: Array.from({ length: 50 }, (_, i) => line({ seq: i + 1 })) }))
        .toHaveLength(50);
    });

    it("rejects an empty array and 51 entries", () => {
      expect(parseEntries({ entries: [] })).toBeNull();
      expect(parseEntries({ entries: Array.from({ length: 51 }, (_, i) => line({ seq: i + 1 })) }))
        .toBeNull();
    });

    it.each([
      ["a missing entries field", {}],
      ["entries that is not an array", { entries: line() }],
      ["a non-object body", null],
    ])("rejects %s", (_name, body) => {
      expect(parseEntries(body)).toBeNull();
    });

    it("rejects the whole batch when one entry is invalid", () => {
      expect(parse(line(), line({ seq: 0 }))).toBeNull();
    });
  });

  describe("kind", () => {
    it("rejects an unknown kind", () => {
      expect(parse({ kind: "banner", seq: 1 })).toBeNull();
    });

    it("rejects an inherited property name as kind", () => {
      expect(parse({ kind: "constructor" })).toBeNull();
    });

    it("rejects a non-object entry", () => {
      expect(parse("line")).toBeNull();
      expect(parse(null)).toBeNull();
    });
  });

  describe("line", () => {
    it("accepts a valid line from either speaker", () => {
      expect(parse(line(), line({ seq: 2, speaker: "agent" }))).toHaveLength(2);
    });

    it("rejects seq 0 and a fractional seq", () => {
      expect(parse(line({ seq: 0 }))).toBeNull();
      expect(parse(line({ seq: 1.5 }))).toBeNull();
    });

    it("rejects a fractional or negative atMs, accepts 0", () => {
      expect(parse(line({ atMs: 0 }))).not.toBeNull();
      expect(parse(line({ atMs: 12.5 }))).toBeNull();
      expect(parse(line({ atMs: -1 }))).toBeNull();
    });

    it("rejects an unknown speaker", () => {
      expect(parse(line({ speaker: "system" }))).toBeNull();
    });

    it("accepts text of 4000 characters, rejects 4001 and empty", () => {
      expect(parse(line({ text: "x".repeat(4000) }))).not.toBeNull();
      expect(parse(line({ text: "x".repeat(4001) }))).toBeNull();
      expect(parse(line({ text: "" }))).toBeNull();
    });
  });

  describe("turn", () => {
    it("accepts fractional stage durations and totalMs", () => {
      expect(parse(turn({ metrics: metrics({ totalMs: 899.75 }) }))).not.toBeNull();
    });

    it("accepts an empty stages object", () => {
      expect(parse(turn({ metrics: metrics({ stages: {} }) }))).not.toBeNull();
    });

    it("rejects an unknown stage key", () => {
      expect(parse(turn({ metrics: metrics({ stages: { stt: 1, magic: 2 } }) }))).toBeNull();
    });

    it("rejects a negative or non-finite stage value", () => {
      expect(parse(turn({ metrics: metrics({ stages: { stt: -1 } }) }))).toBeNull();
      expect(parse(turn({ metrics: metrics({ stages: { stt: Infinity } }) }))).toBeNull();
      expect(parse(turn({ metrics: metrics({ stages: { stt: "5" } }) }))).toBeNull();
    });

    it("rejects stages that is not an object", () => {
      expect(parse(turn({ metrics: metrics({ stages: [] }) }))).toBeNull();
      expect(parse(turn({ metrics: metrics({ stages: null }) }))).toBeNull();
    });

    it("rejects a negative totalMs", () => {
      expect(parse(turn({ metrics: metrics({ totalMs: -1 }) }))).toBeNull();
    });

    it("rejects fractional llmTokens and ttsChars", () => {
      expect(parse(turn({ metrics: metrics({ llmTokens: 1.5 }) }))).toBeNull();
      expect(parse(turn({ metrics: metrics({ ttsChars: 0.5 }) }))).toBeNull();
    });

    it("rejects negative llmTokens and accepts 0", () => {
      expect(parse(turn({ metrics: metrics({ llmTokens: -1 }) }))).toBeNull();
      expect(parse(turn({ metrics: metrics({ llmTokens: 0, ttsChars: 0 }) }))).not.toBeNull();
    });

    it("rejects seq 0, a fractional seq and a fractional atMs", () => {
      expect(parse(turn({ seq: 0 }))).toBeNull();
      expect(parse(turn({ seq: 1.5 }))).toBeNull();
      expect(parse(turn({ atMs: 0.5 }))).toBeNull();
    });

    it("rejects missing metrics", () => {
      expect(parse(turn({ metrics: undefined }))).toBeNull();
    });
  });

  describe("end", () => {
    it("accepts every endedBy of the contract, closed included, without a message", () => {
      expect(ENDED_BY).toContain("closed");
      for (const endedBy of ENDED_BY) {
        expect(parse(end({ endedBy }))).toEqual([{ kind: "end", endedBy, segment: 1 }]);
      }
    });

    it("rejects an unknown endedBy", () => {
      expect(parse(end({ endedBy: "timeout" }))).toBeNull();
    });

    it("keeps the segment it ends", () => {
      expect(parse(end({ segment: 3 }))).toEqual([{ kind: "end", endedBy: "user", segment: 3 }]);
    });

    it.each([
      ["missing", undefined],
      ["0", 0],
      ["negative", -1],
      ["fractional", 1.5],
      ["a string", "1"],
    ])("rejects a segment that is %s", (_name, segment) => {
      expect(parse(end({ segment }))).toBeNull();
    });

    it("accepts a message of 500 characters, rejects 501", () => {
      expect(parse(end({ message: "x".repeat(500) }))).not.toBeNull();
      expect(parse(end({ message: "x".repeat(501) }))).toBeNull();
    });

    it("rejects a message that is not a string", () => {
      expect(parse(end({ message: 5 }))).toBeNull();
    });
  });

  describe("resume", () => {
    it("accepts a segment of 1 or more", () => {
      expect(parse(resume({ segment: 2 }))).toEqual([{ kind: "resume", segment: 2 }]);
      expect(parse(resume({ segment: 1 }))).not.toBeNull();
    });

    it.each([
      ["missing", undefined],
      ["0", 0],
      ["fractional", 2.5],
      ["a string", "2"],
    ])("rejects a segment that is %s", (_name, segment) => {
      expect(parse(resume({ segment }))).toBeNull();
    });
  });

  it("copies only the known fields", () => {
    const parsed = parse(
      line({ extra: 1 }),
      turn({ extra: 1, metrics: metrics({ extra: 1 }) }),
      end({ message: "bye", extra: 1 }),
      resume({ extra: 1 }),
    );
    expect(parsed).toEqual([
      { kind: "line", seq: 1, speaker: "user", text: "hello", atMs: 0 },
      {
        kind: "turn", seq: 1, atMs: 1000,
        metrics: { stages: { stt: 120.5, llm: 300 }, totalMs: 900, llmTokens: 42, ttsChars: 180 },
      },
      { kind: "end", endedBy: "user", segment: 1, message: "bye" },
      { kind: "resume", segment: 2 },
    ]);
  });
});
