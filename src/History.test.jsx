import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { History } from "./History";
import { deleteDialogue, listDialogues, readDialogue } from "./lib/historyApi";

vi.mock("./lib/historyApi");

const summary = { id: "dialogue", startedAt: "2026-11-19T10:00:00Z", durationMs: 1000, endReason: "user" };
const message = { seq: 1, speaker: "user", text: "Can you hear me?", atMs: 100 };

beforeEach(() => {
  vi.resetAllMocks();
  listDialogues.mockResolvedValue({ dialogues: [summary], incomplete: false });
  readDialogue.mockResolvedValue({
    id: summary.id,
    schemaVersion: 1,
    sessions: [{
      id: "session",
      startedAt: summary.startedAt,
      end: { reason: summary.endReason, durationMs: summary.durationMs },
      messages: [message],
    }],
  });
});
afterEach(cleanup);

async function click(name) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

function showHistory() {
  render(<History currentDialogueId={null} onBack={() => {}} />);
}

test("[TC-002] cancelling deletion keeps the open transcript", async () => {
  showHistory();
  await click("Open transcript");
  await screen.findByText(message.text);
  await click("Delete");
  await click("Cancel");

  expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
  expect(screen.getByText(message.text)).toBeTruthy();
  expect(deleteDialogue).not.toHaveBeenCalled();
});

test("[TC-005] a failed deletion keeps the transcript readable until a retry succeeds", async () => {
  deleteDialogue.mockRejectedValueOnce(new TypeError("Offline")).mockImplementationOnce(async () => {
    listDialogues.mockResolvedValue({ dialogues: [], incomplete: false });
  });
  showHistory();
  await click("Open transcript");
  await screen.findByText(message.text);
  await click("Delete");
  await click("Confirm delete");

  await screen.findByText("Couldn’t delete this dialogue. Try again.");
  expect(screen.getByText(message.text)).toBeTruthy();
  await click("Confirm delete");
  await screen.findByText("No dialogues yet.");
  expect(screen.queryByText(message.text)).toBeNull();
});

test("[TC-008] the reader can retry loading the list and the selected transcript", async () => {
  listDialogues.mockRejectedValueOnce(new TypeError("Offline"));
  readDialogue.mockRejectedValueOnce(new TypeError("Offline"));
  showHistory();

  await screen.findByText("Couldn’t load history.");
  expect(screen.queryByText("No dialogues yet.")).toBeNull();
  await click("Retry");
  await click("Open transcript");
  const transcript = within(await screen.findByRole("region", { name: "Transcript" }));
  await transcript.findByText("Couldn’t load this transcript.");
  fireEvent.click(transcript.getByRole("button", { name: "Retry" }));
  await transcript.findByText(message.text);
});
