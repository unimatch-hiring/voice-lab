import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const LOCAL_HISTORY_URL = "http://localhost:8788";
const CONFIGURED_URL = "https://history.example.test";

describe("loadConfig historyUrl", () => {
  it("points a dev build at the local server when the variable is unset", () => {
    expect(loadConfig("", { DEV: true }).historyUrl).toBe(LOCAL_HISTORY_URL);
  });

  it("is null in a production build when the variable is unset", () => {
    expect(loadConfig("", { DEV: false }).historyUrl).toBeNull();
  });

  it("treats an empty variable as unset", () => {
    expect(loadConfig("", { DEV: false, VITE_HISTORY_URL: "" }).historyUrl).toBeNull();
  });

  it("drops a trailing slash so request paths do not start with //", () => {
    const config = loadConfig("", { DEV: false, VITE_HISTORY_URL: `${CONFIGURED_URL}/` });

    expect(config.historyUrl).toBe(CONFIGURED_URL);
  });

  it.each([true, false])("lets the variable win when DEV is %s", (dev) => {
    const config = loadConfig("", { DEV: dev, VITE_HISTORY_URL: CONFIGURED_URL });

    expect(config.historyUrl).toBe(CONFIGURED_URL);
  });
});

describe("loadConfig worker and token", () => {
  it("falls back to the stored token and the default worker", () => {
    const config = loadConfig("stored", { DEV: false });

    expect(config.vibeToken).toBe("stored");
    expect(config.workerUrl).toMatch(/^https:\/\//);
    expect(config.offline).toBe(false);
  });

  it("reads the worker and token from the env passed in", () => {
    const config = loadConfig("stored", {
      DEV: false,
      VITE_WORKER_URL: "https://worker.test",
      VITE_VIBE_TOKEN: "built-in",
    });

    expect(config).toMatchObject({
      workerUrl: "https://worker.test",
      vibeToken: "built-in",
      offline: false,
    });
  });

  it("is offline without any token", () => {
    expect(loadConfig("", { DEV: false }).offline).toBe(true);
  });
});
