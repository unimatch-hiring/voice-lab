import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Parent } from "./Parent";
import type { ParentApi } from "./lib/parental/parentApi";
import type { ParentSettings } from "./lib/parental/types";

afterEach(cleanup);

const STORED: ParentSettings = {
  allowedTopics: "space",
  blockedTopics: "horror films",
  childProfile: "Masha, 7",
  triggerWords: "",
};

function fakeApi(overrides: Partial<ParentApi> = {}): ParentApi {
  return {
    getSettings: vi.fn(async () => STORED),
    saveSettings: vi.fn(async (s: ParentSettings) => s),
    ...overrides,
  };
}

describe("parent page", () => {
  it("shows what the parent saved last time", async () => {
    render(<Parent api={fakeApi()} />);

    expect(((await screen.findByLabelText(/must not discuss/i)) as HTMLTextAreaElement).value).toBe(
      "horror films",
    );
    expect((screen.getByLabelText(/about the child/i) as HTMLTextAreaElement).value).toBe("Masha, 7");
  });

  it("saves every field, not only the one edited", async () => {
    const api = fakeApi();
    render(<Parent api={api} />);

    fireEvent.change(await screen.findByLabelText(/alarm words/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith({ ...STORED, triggerWords: "secret" }),
    );
    expect(await screen.findByText(/saved\./i)).toBeTruthy();
  });

  it("says so when the server is down instead of showing an empty form", async () => {
    render(<Parent api={fakeApi({ getSettings: () => Promise.reject(new Error("down")) })} />);

    expect(await screen.findByText(/not reachable/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });
});
