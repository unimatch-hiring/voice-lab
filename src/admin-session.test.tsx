import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "./Admin";

// jsdom has no IndexedDB, so the store is faked; a saved session puts the page straight in.
const cleared = vi.fn();
vi.mock("./lib/tokenStore", () => ({
  loadAdminToken: () => Promise.resolve("session-1"),
  saveAdminToken: () => Promise.resolve(),
  clearAdminToken: () => {
    cleared();
    return Promise.resolve();
  },
}));

const FULL_KEY = "vibe_0123456789abcdef0123456789abcdef0123456789abcdef";
const LISTED = {
  id: "a".repeat(64),
  hint: "vibe_0123…cdef",
  label: "Ivan Testov",
  engine: "elevenlabs",
  issuedAt: 1,
  expiresAt: Date.now() + 3600_000,
};

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function worker(route: Route = () => Response.json({ keys: [LISTED] })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => route(String(url), init));
}

const calls = (spy: ReturnType<typeof worker>) =>
  spy.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);

beforeEach(() => cleared.mockClear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("signing out of the admin page", () => {
  it("ends the session on the Worker, not only in this browser", async () => {
    const spy = worker((url) =>
      url.endsWith("/admin/signout") ? Response.json({ ok: true }) : Response.json({ keys: [] }),
    );
    render(<Admin />);

    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(calls(spy)).toContain("POST /admin/signout"));
  });

  it("still forgets the session here when the Worker cannot be reached", async () => {
    worker((url) => {
      if (url.endsWith("/admin/signout")) throw new TypeError("Failed to fetch");
      return Response.json({ keys: [] });
    });
    render(<Admin />);

    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    expect(await screen.findByLabelText(/work email/i)).toBeTruthy();
    expect(cleared).toHaveBeenCalled();
  });
});

describe("the key list", () => {
  it("shows the masked key the Worker sends", async () => {
    worker();
    render(<Admin />);

    expect(await screen.findByText(LISTED.hint)).toBeTruthy();
  });

  it("revokes a listed key by its id", async () => {
    const spy = worker();
    render(<Admin />);

    fireEvent.click(await screen.findByRole("button", { name: /revoke/i }));

    await waitFor(() => expect(calls(spy)).toContain(`DELETE /admin/keys/${LISTED.id}`));
  });

  it("switches a listed key's engine by its id", async () => {
    const spy = worker();
    render(<Admin />);

    fireEvent.click(await screen.findByRole("button", { name: /switch to/i }));

    await waitFor(() => expect(calls(spy)).toContain(`PATCH /admin/keys/${LISTED.id}`));
  });

  it("still shows a freshly issued key in full, so it can be handed to the candidate", async () => {
    worker((_url, init) =>
      init?.method === "POST"
        ? Response.json({ ...LISTED, token: FULL_KEY })
        : Response.json({ keys: [LISTED] }),
    );
    render(<Admin />);

    fireEvent.click(await screen.findByRole("button", { name: /issue key/i }));

    expect(await screen.findByText(FULL_KEY)).toBeTruthy();
  });
});
