import { describe, expect, it, vi } from "vitest";
import { createParentApi, ParentApiError } from "./parentApi";
import { EMPTY_SETTINGS } from "./types";

describe("parent API client", () => {
  it("sends the settings as JSON to the settings route", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(EMPTY_SETTINGS)));

    await createParentApi("/api", fetchImpl).saveSettings(EMPTY_SETTINGS);

    expect(fetchImpl).toHaveBeenCalledWith("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(EMPTY_SETTINGS),
    });
  });

  it("turns a failed answer into an error, not into settings", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));

    await expect(createParentApi("/api", fetchImpl).getSettings()).rejects.toBeInstanceOf(
      ParentApiError,
    );
  });
});
