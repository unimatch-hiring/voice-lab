import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "./config";

afterEach(() => vi.unstubAllEnvs());

test.each([
  { dev: true, configured: undefined, expected: "http://127.0.0.1:8788" },
  { dev: false, configured: undefined, expected: "" },
  { dev: false, configured: "https://profiles.example.test", expected: "https://profiles.example.test" },
])("resolves the profile server URL with dev=$dev and configured=$configured", ({ dev, configured, expected }) => {
  vi.stubEnv("DEV", dev);
  vi.stubEnv("VITE_CHILD_LLM_URL", configured);
  expect(loadConfig().childServerUrl).toBe(expected);
});
