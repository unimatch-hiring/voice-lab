import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve("vibe_test"),
  saveToken: () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

test("the panel header links to the history where a history server is configured", async () => {
  vi.stubEnv("VITE_HISTORY_URL", "http://history.test");
  render(<App />);

  const link = await screen.findByRole("link", { name: "history" });
  expect(link.getAttribute("href")).toBe("?history");
});

test("there is no history link where history is off", async () => {
  vi.stubEnv("VITE_HISTORY_URL", "");
  vi.stubEnv("DEV", false);
  render(<App />);

  await screen.findByRole("button", { name: /start conversation/i });
  expect(screen.queryByRole("link", { name: "history" })).toBeNull();
});
