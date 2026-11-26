import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Parent } from "./Parent";
import type { ParentApi } from "./lib/parental/parentApi";
import type { Flag, ParentSettings } from "./lib/parental/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    reviewFlag: vi.fn(async () => ({ flagged: false })),
    listFlags: vi.fn(async (): Promise<Flag[]> => []),
    deleteChildData: vi.fn(async () => ({ deleted: true })),
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

  it("shows each flag with the child's full message and whether it was verified", async () => {
    const flags: Flag[] = [
      {
        id: "1",
        at: 0,
        status: "confirmed",
        category: "abuse",
        severity: "high",
        reason: "Talks about being hit at home.",
        text: "Papa hits me when mum is at work",
        matched: ["hits me"],
        context: [{ role: "assistant", text: "How was your day?" }],
      },
      {
        id: "2",
        at: 0,
        status: "unverified",
        text: "I want to die in this game",
        matched: ["want to die"],
        context: [],
      },
    ];
    render(<Parent api={fakeApi({ listFlags: async () => flags })} />);

    expect(await screen.findByText("Papa hits me when mum is at work")).toBeTruthy();
    expect(screen.getByText("Talks about being hit at home.")).toBeTruthy();
    expect(screen.getByText("How was your day?")).toBeTruthy();
    expect(screen.getByText("I want to die in this game")).toBeTruthy();
    expect(screen.getByText(/not verified/i)).toBeTruthy();
  });

  it("deletes nothing when the parent cancels the confirmation", async () => {
    const api = fakeApi();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Parent api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete all data/i }));

    expect(api.deleteChildData).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/about the child/i) as HTMLTextAreaElement).value).toBe("Masha, 7");
  });

  it("after confirmation clears the flags and the profile, keeps the topics", async () => {
    const flag: Flag = { id: "1", at: 0, status: "unverified", text: "secret words", matched: ["secret"], context: [] };
    const api = fakeApi({ listFlags: async () => [flag] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Parent api={api} />);

    expect(await screen.findByText("secret words")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /delete all data/i }));

    await waitFor(() => expect(screen.queryByText("secret words")).toBeNull());
    expect(api.deleteChildData).toHaveBeenCalledOnce();
    expect((screen.getByLabelText(/about the child/i) as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText(/must not discuss/i) as HTMLTextAreaElement).value).toBe("horror films");
  });

  it("says so when the server is down instead of showing an empty form", async () => {
    render(<Parent api={fakeApi({ getSettings: () => Promise.reject(new Error("down")) })} />);

    expect(await screen.findByText(/not reachable/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });
});
