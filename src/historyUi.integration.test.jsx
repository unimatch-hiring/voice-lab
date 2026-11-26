import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@elevenlabs/client";
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { VoiceLab } from "./VoiceLab";
import { createHistoryServer } from "../server/index.js";

configure({ asyncUtilTimeout: 4_000 });

let provider;
let voiceKey = "voice-key";
let dataDir;
let server;
let historyOnline;
let loseNextAcknowledgement;
let requestHistory;
vi.mock("@elevenlabs/client", () => ({
  Conversation: {
    startSession: async (callbacks) => {
      provider = callbacks;
      callbacks.onMessage({ source: "ai", message: "Welcome to Voice Lab" });
      return {
        endSession: async () => callbacks.onDisconnect({ reason: "user" }),
      };
    },
  },
}));

vi.mock("./lib/tokenStore", () => ({
  loadToken: () => Promise.resolve(voiceKey),
  saveToken: () => Promise.resolve(),
}));

afterEach(async () => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  voiceKey = "voice-key";
  history.replaceState(null, "", location.pathname);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

const click = async (name) => fireEvent.click(await screen.findByRole("button", { name }));

beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  dataDir = await mkdtemp(join(tmpdir(), "voice-lab-ui-"));
  server = createHistoryServer({ dataDir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  vi.stubEnv("VITE_HISTORY_URL", origin);
  historyOnline = true;
  loseNextAcknowledgement = false;
  const fetchHttp = globalThis.fetch;
  requestHistory = (path, options) => fetchHttp(origin + path, options);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url).startsWith(origin)) {
      if (!historyOnline) throw new TypeError("History connection unavailable");
      const response = await fetchHttp(url, options);
      if (loseNextAcknowledgement && options?.method === "PUT" && response.ok) {
        loseNextAcknowledgement = false;
        throw new TypeError("History response dropped");
      }
      return response;
    }
    return Promise.resolve(Response.json({ engine: "elevenlabs", token: "voice-grant" }));
  });
});

test("[TC-001] two Start/Stop cycles share one continuous transcript that can be reopened", { timeout: 12_000 }, async () => {
  let elapsed = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const main = render(<VoiceLab />);
  await screen.findByText("Step 2 — press it, allow the microphone, then just talk.");
  await click("Start conversation");
  await screen.findByRole("button", { name: "End conversation" });
  act(() => {
    provider.onMessage({ source: "user", message: "Tell me about history" });
    provider.onModeChange({ mode: "speaking" });
    provider.onAgentChatResponsePart({ text: "You can read it later" });
    provider.onModeChange({ mode: "listening" });
    provider.onMessage({ source: "ai", message: "You can read it later" });
  });
  expect(screen.getAllByText("You can read it later")).toHaveLength(1);
  await click("History");
  await click("Open transcript");
  const transcript = await screen.findByRole("heading", { name: "Transcript" });
  const historyPage = within(transcript.closest("main"));
  expect(await historyPage.findByText("Welcome to Voice Lab")).toBeTruthy();
  expect(await historyPage.findByText("Tell me about history")).toBeTruthy();
  expect(await historyPage.findByText("You can read it later")).toBeTruthy();
  act(() => provider.onMessage({ source: "user", message: "I can keep talking" }));
  expect(await historyPage.findByText("I can keep talking")).toBeTruthy();
  await click("Back to voice-lab");

  elapsed += 120_000;
  await click("End conversation");
  elapsed += 600_000;
  await click("Start conversation");
  await screen.findByRole("button", { name: "End conversation" });
  act(() => provider.onMessage({ source: "user", message: "Let's continue" }));
  elapsed += 180_000;
  await click("End conversation");
  await click("History");
  expect(await screen.findByText("5 min", { exact: false })).toBeTruthy();
  await click("Back to voice-lab");

  main.unmount();
  voiceKey = "";
  render(<VoiceLab />);
  await click("History");
  expect(await screen.findByText("5 min", { exact: false })).toBeTruthy();
  expect(screen.getByText("Stopped by user", { exact: false })).toBeTruthy();
  await click("Open transcript");
  const reopened = within(await screen.findByRole("region", { name: "Transcript" }));
  await reopened.findByText("Let's continue");
  const utterances = within(reopened.getByRole("list")).getAllByRole("listitem");
  const transcriptLines = utterances.map((item) => {
    const line = within(item);
    return [line.getByText(/^(User|Agent)$/).textContent, line.getByRole("paragraph").textContent];
  });
  expect(transcriptLines).toEqual([
    ["Agent", "Welcome to Voice Lab"],
    ["User", "Tell me about history"],
    ["Agent", "You can read it later"],
    ["User", "I can keep talking"],
    ["Agent", "Welcome to Voice Lab"],
    ["User", "Let's continue"],
  ]);
});

async function sayAndStop(message) {
  await screen.findByText("Step 2 — press it, allow the microphone, then just talk.");
  await click("Start conversation");
  await screen.findByRole("button", { name: "End conversation" });
  act(() => provider.onMessage({ source: "user", message }));
  await click("End conversation");
  await screen.findByRole("button", { name: "Start conversation" });
}

async function openDialogueFromAnotherPage(originatingPage) {
  originatingPage.unmount();
  render(<VoiceLab />);
  await click("Open transcript");
  return within(await screen.findByRole("region", { name: "Transcript" }));
}

test("[TC-002] only another page can confirm deletion of the current dialogue", async () => {
  const page = render(<VoiceLab />);
  await click("Start conversation");
  await screen.findByRole("button", { name: "End conversation" });
  await click("History");
  await screen.findByRole("button", { name: "Open transcript" });
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  await click("Back to voice-lab");
  await click("End conversation");
  await click("History");
  await screen.findByText("Stopped by user");
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

  const transcript = await openDialogueFromAnotherPage(page);
  await transcript.findByText("Welcome to Voice Lab");
  await click("Delete");
  await click("Confirm delete");
  expect(await screen.findByText("No dialogues yet.")).toBeTruthy();
});

test("[TC-006] pending utterances recover after Stop and after reopening, once and in order", { timeout: 12_000 }, async () => {
  historyOnline = false;
  const page = render(<VoiceLab />);
  await sayAndStop("Spoken during the first outage");
  const trying = /history isn.t saving right now/i;
  await screen.findByText(trying);
  expect(screen.getByText("Spoken during the first outage")).toBeTruthy();

  loseNextAcknowledgement = true;
  historyOnline = true;
  await waitFor(() => expect(screen.queryByText(trying)).toBeNull(), { timeout: 5_000 });
  await click("History");
  await click("Open transcript");
  const firstTranscript = within(await screen.findByRole("region", { name: "Transcript" }));
  expect(await firstTranscript.findByText("Spoken during the first outage")).toBeTruthy();
  await click("Back to voice-lab");

  historyOnline = false;
  await sayAndStop("Spoken before reopening");
  await screen.findByText(trying);
  await click("History");
  await within(screen.getByRole("main")).findByText(trying);
  page.unmount();
  historyOnline = true;
  render(<VoiceLab />);
  await click("Open transcript");
  const reopened = within(await screen.findByRole("region", { name: "Transcript" }));
  await reopened.findByText("Spoken before reopening");
  expect(reopened.getAllByRole("paragraph").map((line) => line.textContent)).toEqual([
    "Welcome to Voice Lab",
    "Spoken during the first outage",
    "Welcome to Voice Lab",
    "Spoken before reopening",
  ]);
});

test("[TC-007] replaying a deleted dialogue does not block the next conversation", { timeout: 12_000 }, async () => {
  const page = render(<VoiceLab />);
  await sayAndStop("Dialogue to delete from another tab");
  await click("History");
  await click("Open transcript");
  await within(await screen.findByRole("region", { name: "Transcript" }))
    .findByText("Dialogue to delete from another tab");
  await click("Back to voice-lab");

  historyOnline = false;
  await sayAndStop("Do not restore this utterance");
  await screen.findByText(/history isn.t saving right now/i);
  const [previousDialogue] = await (await requestHistory("/dialogues")).json();
  await requestHistory(`/dialogues/${previousDialogue.id}`, { method: "DELETE" });
  page.unmount();

  historyOnline = true;
  render(<VoiceLab />);
  await sayAndStop("New conversation still saves");
  await click("History");
  await click("Open transcript");
  const transcript = within(await screen.findByRole("region", { name: "Transcript" }));
  expect(await transcript.findByText("New conversation still saves")).toBeTruthy();
  expect(transcript.queryByText("Do not restore this utterance")).toBeNull();
});

test("[TC-008] a damaged dialogue file shows a partial history with the intact transcript still readable", async () => {
  await writeFile(join(dataDir, "damaged.json"), "{");
  render(<VoiceLab />);
  await sayAndStop("Keep this intact transcript");
  await click("History");
  await screen.findByText("Some dialogues couldn’t be loaded.");
  await click("Open transcript");
  const transcript = within(await screen.findByRole("region", { name: "Transcript" }));
  await transcript.findByText("Keep this intact transcript");
});

test("[TC-004] forgetting the voice key keeps the known ending and duration in history", async () => {
  let elapsed = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  render(<VoiceLab />);
  await click("Start conversation");
  await screen.findByRole("button", { name: "End conversation" });
  elapsed += 120_000;
  await click("settings");
  await click("Forget token");
  await screen.findByText("Step 1 — paste your access token");
  await click("History");
  await screen.findByText("Stopped by user");
  expect(screen.getByText("2 min")).toBeTruthy();
  await click("Open transcript");
  const transcript = within(await screen.findByRole("region", { name: "Transcript" }));
  expect(await transcript.findByText("Welcome to Voice Lab")).toBeTruthy();
});

async function pressStartFromMainPage() {
  render(<VoiceLab />);
  await screen.findByText("Step 2 — press it, allow the microphone, then just talk.");
  await click("Start conversation");
}

async function openSavedTranscript(ending) {
  await click("History");
  await screen.findByText(ending);
  await click("Open transcript");
  return within(await screen.findByRole("region", { name: "Transcript" }));
}

test("[TC-017] history keeps the final reply when the agent ends the conversation", async () => {
  await pressStartFromMainPage();
  await screen.findByRole("button", { name: "End conversation" });
  act(() => {
    provider.onMessage({ source: "ai", message: "That covers everything. Goodbye!" });
    provider.onDisconnect({ reason: "agent" });
  });

  const transcript = await openSavedTranscript("Ended by agent");
  expect(await transcript.findByText("That covers everything. Goodbye!")).toBeTruthy();
});

test("[TC-018] a dropped connection leaves the saved transcript readable with a failed ending", async () => {
  await pressStartFromMainPage();
  await screen.findByRole("button", { name: "End conversation" });
  act(() => provider.onMessage({ source: "user", message: "I have one more question." }));
  await click("History");
  await click("Open transcript");
  const beforeDrop = within(await screen.findByRole("region", { name: "Transcript" }));
  await beforeDrop.findByText("I have one more question.");
  await click("Back to voice-lab");

  act(() => provider.onDisconnect({ reason: "error", message: "Connection lost" }));
  const transcript = await openSavedTranscript("Conversation failed");
  expect(await transcript.findByText("I have one more question.")).toBeTruthy();
});

test("[TC-019] a failed start keeps the opening line and records the failure", async () => {
  vi.spyOn(Conversation, "startSession").mockImplementationOnce(async (callbacks) => {
    callbacks.onMessage({ source: "ai", message: "Hello, can you hear me?" });
    throw new Error("Could not connect");
  });
  await pressStartFromMainPage();
  await screen.findByText("Could not connect");

  const transcript = await openSavedTranscript("Conversation failed");
  expect(await transcript.findByText("Hello, can you hear me?")).toBeTruthy();
});

test("[TC-020] an entirely silent Start/Stop leaves history empty", async () => {
  vi.spyOn(Conversation, "startSession").mockImplementationOnce(async (callbacks) => ({
    endSession: async () => callbacks.onDisconnect({ reason: "user" }),
  }));
  await pressStartFromMainPage();
  await click("End conversation");
  await screen.findByRole("button", { name: "Start conversation" });
  await click("History");

  expect(await screen.findByText("No dialogues yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open transcript" })).toBeNull();

  // Reopen after a later save so a slow write from the silent session cannot hide behind the empty list.
  await click("Back to voice-lab");
  await sayAndStop("First spoken words");
  const transcript = await openSavedTranscript("Stopped by user");
  await transcript.findByText("First spoken words");
  expect(transcript.getAllByRole("paragraph").map((line) => line.textContent)).toEqual([
    "Welcome to Voice Lab",
    "First spoken words",
  ]);
});

test("[TC-021] Stop records the user ending even without a provider disconnect callback", async () => {
  vi.spyOn(Conversation, "startSession").mockImplementationOnce(async (callbacks) => {
    provider = callbacks;
    return { endSession: async () => {} };
  });
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  await pressStartFromMainPage();
  await screen.findByRole("button", { name: "End conversation" });
  elapsed = 5_000;
  act(() => provider.onMessage({ source: "user", message: "Thanks for your help." }));
  elapsed = 20_000;
  await click("End conversation");

  const transcript = await openSavedTranscript("Stopped by user");
  expect(screen.getByText("20 sec")).toBeTruthy();
  expect(await transcript.findByText("Thanks for your help.")).toBeTruthy();
});

test("[TC-011] a damaged dialogue warns the speaker and the rejected utterance is not retried", async () => {
  await pressStartFromMainPage();
  const beforeDamage = await openSavedTranscript("No ending recorded");
  await beforeDamage.findByText("Welcome to Voice Lab");
  await click("Back to voice-lab");

  const [dialogue] = await (await requestHistory("/dialogues")).json();
  const path = join(dataDir, dialogue.id + ".json");
  const original = await readFile(path);
  await writeFile(path, "{");

  const saveStatuses = [];
  server.on("request", (request, response) => {
    if (request.method === "PUT") response.once("finish", () => saveStatuses.push(response.statusCode));
  });
  act(() => provider.onMessage({ source: "user", message: "Spoken while the file was damaged" }));
  await screen.findByText("Some earlier history could not be saved.");
  expect(saveStatuses).toEqual([409]);

  await writeFile(path, original);
  act(() => provider.onMessage({ source: "user", message: "Spoken after repair" }));
  const repaired = await openSavedTranscript("No ending recorded");
  await repaired.findByText("Spoken after repair");
  expect(repaired.getAllByRole("paragraph").map((line) => line.textContent)).toEqual([
    "Welcome to Voice Lab",
    "Spoken after repair",
  ]);
  expect(saveStatuses).toEqual([409, 204]);
});

test("[TC-010] a final reply after Stop remains in the original session with its known ending", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  await pressStartFromMainPage();
  await screen.findByRole("button", { name: "End conversation" });
  elapsed = 20_000;
  await click("End conversation");
  elapsed = 40_000;
  act(() => provider.onMessage({ source: "ai", message: "One last thing." }));

  const transcript = await openSavedTranscript("Stopped by user");
  await transcript.findByText("One last thing.");
  expect(screen.getByText("20 sec")).toBeTruthy();
});

test("[TC-026] a hosted build without history explains this before the speaker starts", async () => {
  const originalUrl = location.href;
  vi.stubEnv("VITE_HISTORY_URL", "");
  jsdom.reconfigure({ url: "https://voice.example/voice-lab/" });
  const message = "History is unavailable on this site.";
  const writes = vi.spyOn(Storage.prototype, "setItem");
  try {
    render(<VoiceLab />);
    await screen.findByText(message);
    await sayAndStop("Voice still works");
    expect(screen.getByText("Voice still works")).toBeTruthy();
    await click("History");
    await within(screen.getByRole("main")).findByText(message);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(writes.mock.calls.some(([key]) => key.startsWith("voice-lab:history-pending:"))).toBe(false);
  } finally {
    jsdom.reconfigure({ url: originalUrl });
  }
});
