// @vitest-environment node

import { resolve } from "node:path";
import { build, isFileLoadingAllowed, resolveConfig } from "vite";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

test("the frontend dev server keeps profile data and debug logs private", async () => {
  const config = await resolveConfig({}, "serve");
  for (const path of ["server/.data/voice-lab.sqlite", "server/logs/turn-reviews.jsonl"]) {
    expect(isFileLoadingAllowed(config, resolve(config.root, path)), path).toBe(false);
  }
  expect(isFileLoadingAllowed(config, resolve(config.root, "src/main.tsx"))).toBe(true);
});

test("a nested Pages preview has one entry and loads its script from the same base", async () => {
  const base = "/voice-lab-previews/branch/feature/";
  vi.stubEnv("BASE_PATH", base);
  const result = await build({ build: { write: false }, logLevel: "silent" });
  if (!("output" in result)) throw new Error("Expected a single Vite build output");

  const pages = result.output.filter(({ fileName }) => fileName.endsWith(".html"));
  expect(pages.map(({ fileName }) => fileName)).toEqual(["index.html"]);
  const entry = result.output.find((file) => file.type === "chunk" && file.isEntry);
  expect(entry).toBeDefined();
  expect(pages[0]).toMatchObject({
    type: "asset",
    source: expect.stringContaining(`src="${base}${entry?.fileName}"`),
  });
});
