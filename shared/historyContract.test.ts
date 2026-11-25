import { describe, expect, it } from "vitest";
import { STAGE_ORDER } from "../src/lib/types";
import { STAGE_NAMES } from "./historyContract.js";

describe("history contract", () => {
  // The server cannot import the pipeline's TypeScript, so the contract restates the stages.
  it("lists exactly the pipeline's stages, in order", () => {
    expect([...STAGE_NAMES]).toEqual([...STAGE_ORDER]);
  });
});
