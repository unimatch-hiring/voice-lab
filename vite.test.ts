// @vitest-environment node

import { resolve } from "node:path";
import { isFileLoadingAllowed, resolveConfig } from "vite";
import { expect, test } from "vitest";

test("the frontend dev server keeps profile data and debug logs private", async () => {
  const config = await resolveConfig({}, "serve");
  for (const path of ["server/.data/voice-lab.sqlite", "server/logs/turn-reviews.jsonl"]) {
    expect(isFileLoadingAllowed(config, resolve(config.root, path)), path).toBe(false);
  }
  expect(isFileLoadingAllowed(config, resolve(config.root, "src/main.tsx"))).toBe(true);
});
