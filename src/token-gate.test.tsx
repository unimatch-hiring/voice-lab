import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { App, startFailureMessage } from "./App";
import { WorkerError } from "./lib/transport";

// jsdom has no IndexedDB, so the store is faked.
let stored = "";
vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve(stored),
  saveToken: (t: string) => {
    stored = t;
    return Promise.resolve();
  },
}));

// Lets a test decide how starting a conversation fails, without a microphone or socket.
let startFails: unknown = null;
vi.mock("./lib/pipeline/createSession", () => ({
  createSession: () => ({
    isRunning: false,
    mouthSpectrum: () => null,
    start: () => (startFails ? Promise.reject(startFails) : Promise.resolve()),
    stop: () => Promise.resolve(),
  }),
}));

beforeEach(() => {
  startFails = null;
  stored = "";
  // With a token the page asks the Worker for its engine; tests must not reach the network.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

describe("start failures on the backup engine", () => {
  test("a 401 from the Worker says the access token was not accepted", () => {
    const msg = startFailureMessage(new WorkerError("/deepgram-token", 401), "deepgram");
    expect(msg).toMatch(/not accepted or has expired/i);
  });

  test("a 502 from the Worker blames the engine, not the token", () => {
    const msg = startFailureMessage(new WorkerError("/deepgram-token", 502), "deepgram");
    expect(msg).toBe("Backup engine is unavailable right now, try again later.");
    expect(msg).not.toMatch(/token/i);
  });

  test("a network failure blames the engine too", () => {
    expect(startFailureMessage(new TypeError("Failed to fetch"), "deepgram")).toMatch(
      /backup engine is unavailable/i,
    );
  });

  test("a blocked microphone is still reported as such", () => {
    const denied = new DOMException("Permission denied", "NotAllowedError");
    expect(startFailureMessage(denied, "deepgram")).toMatch(/microphone is blocked/i);
  });

  test("the page words a Worker outage on the backup engine as an outage", async () => {
    stored = "vibe_test";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("/engine")
        ? new Response(JSON.stringify({ engine: "deepgram" }), { status: 200 })
        : new Response("{}", { status: 404 }),
    );
    startFails = new WorkerError("/deepgram-token", 502);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /start conversation/i }));

    expect(
      await screen.findByText("Backup engine is unavailable right now, try again later."),
    ).toBeTruthy();
    expect(screen.queryByText(/access token was rejected/i)).toBeNull();
  });

  test("ElevenLabs keeps its wording", () => {
    expect(startFailureMessage(new WorkerError("/agent/token", 401))).toBe(
      "The access token was rejected. Open settings and paste it again.",
    );
  });
});

describe("the backup engine notice", () => {
  const workerSays = (engine: string) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("/engine")
        ? new Response(JSON.stringify({ engine }), { status: 200 })
        : new Response("{}", { status: 404 }),
    );

  test("is on screen when the key is set to Deepgram", async () => {
    stored = "vibe_test";
    workerSays("deepgram");
    render(<App />);

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Backup engine: English only, Deepgram voice",
    );
  });

  test("is absent on ElevenLabs", async () => {
    stored = "vibe_test";
    const fetchSpy = workerSays("elevenlabs");
    render(<App />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/backup engine/i)).toBeNull();
  });
});
