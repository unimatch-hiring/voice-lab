import { afterEach, expect, test, vi } from "vitest";
import index from "../index.html?raw";
import { ParentControl } from "./parent/ParentControl";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));

afterEach(() => vi.unstubAllEnvs());

test("the parent alias replaces the URL and opens the English profiles page", async () => {
  vi.stubEnv("BASE_URL", "/voice-lab/");
  const entry = new DOMParser().parseFromString(index, "text/html");
  document.documentElement.lang = entry.documentElement.lang;
  window.history.replaceState(null, "", "/voice-lab/?parent");

  await import("./main");

  expect(window.location.pathname + window.location.search).toBe("/voice-lab/?parent=local-parent");
  expect(document.documentElement.lang).toBe("en");
  expect(document.title).toBe("Child profiles · voice-lab");
  expect(render).toHaveBeenCalledWith(expect.objectContaining({ type: ParentControl }));
});
