import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { App, startFailureMessage } from "./App";

// jsdom has no IndexedDB, so the store is faked.
let stored = "";
vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve(stored),
  saveToken: (t: string) => {
    stored = t;
    return Promise.resolve();
  },
}));

beforeEach(() => {
  stored = "";
});

afterEach(cleanup);

// Regression: the field sat behind the settings toggle, so a first-time visitor saw
// only a disabled button.
test("the token field is on screen without opening settings", async () => {
  render(<App />);

  await waitFor(() => {
    expect(screen.getByLabelText(/access token/i)).toBeTruthy();
  });
});

test("the start button explains that the token is what unblocks it", async () => {
  render(<App />);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /start conversation/i }).hasAttribute("disabled")).toBe(
      true,
    );
  });
  expect(screen.getByText(/paste the access token/i)).toBeTruthy();
});

test("once a token is stored the gate steps aside", async () => {
  stored = "vibe_test";
  render(<App />);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /start conversation/i }).hasAttribute("disabled")).toBe(
      false,
    );
  });
  expect(screen.queryByLabelText(/access token/i)).toBeNull();
});

// The gate is open regardless while there is no token, so a toggle here would be a
// control that visibly does nothing.
test("no settings toggle while the gate is the page", async () => {
  render(<App />);

  await waitFor(() => {
    expect(screen.getByLabelText(/access token/i)).toBeTruthy();
  });
  expect(screen.queryByRole("button", { name: /settings|close/i })).toBeNull();
});

test("saving a token closes the drawer instead of leaving it on 'close'", async () => {
  stored = "vibe_test";
  render(<App />);

  const toggle = await screen.findByRole("button", { name: /settings/i });
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /forget token/i }));

  await waitFor(() => {
    expect(screen.getByLabelText(/access token/i)).toBeTruthy();
  });
  expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
});

test("with a token the page says the next step is the microphone", async () => {
  stored = "vibe_test";
  render(<App />);

  await waitFor(() => {
    expect(screen.getByText(/allow the microphone/i)).toBeTruthy();
  });
});

// The browser says only "Permission denied", which names neither the permission nor
// where to change it.
test("a denied microphone says what to do about it", () => {
  const denied = new DOMException("Permission denied", "NotAllowedError");

  expect(startFailureMessage(denied)).toMatch(/microphone is blocked/i);
  expect(startFailureMessage(denied)).toMatch(/address bar/i);
});

test("a rejected token points back at settings", () => {
  expect(startFailureMessage(new Error("agent token failed: 401"))).toMatch(/paste it again/i);
});

test("an unrecognised failure is passed through rather than swallowed", () => {
  expect(startFailureMessage(new Error("websocket closed unexpectedly"))).toBe(
    "websocket closed unexpectedly",
  );
});
