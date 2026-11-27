import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationDetail, ConversationPage, HistoryApi, StoredConversation, StoredLine, StoredTurn,
} from "../lib/historyApi";
import { HistoryPage } from "./HistoryPage";

afterEach(cleanup);

const at = (day: number, hour: number, minute: number) => Date.UTC(2026, 10, day, hour, minute);

/** What the server keeps; `state` is derived from it and the clock when the server answers. */
type SeedConversation = Omit<StoredConversation, "state">;
type SeedDetail = Omit<ConversationDetail, "conversation"> & { conversation: SeedConversation };

function stored(id: string, startedAt: number, lengthMs: number, endedBy: StoredConversation["endedBy"], endMessage: string | null = null): SeedConversation {
  return {
    id, agentId: "agent_1", startedAt, lastEntryAt: startedAt + lengthMs, endedAt: startedAt + lengthMs,
    endedBy, endMessage, lineCount: 0, turnCount: 0,
  };
}

/** No ending arrived: the last entry came `lengthMs` after the start. */
function storedWithoutEnding(id: string, startedAt: number, lengthMs: number): SeedConversation {
  return { ...stored(id, startedAt, lengthMs, null), endedAt: null };
}

const turn = (seq: number, atMs: number, llm: number, totalMs: number): StoredTurn => ({
  seq, atMs, metrics: { stages: { vad: 240, stt: 300, llm, tts: 150 }, totalMs, llmTokens: 100, ttsChars: 400 },
});

const line = (seq: number, speaker: StoredLine["speaker"], text: string, atMs: number): StoredLine => ({
  seq, speaker, text, atMs,
});

/** The server's clock in these tests; a conversation without an ending is judged against it. */
const SERVER_NOW = at(25, 12, 0);
/** Server rule: no ending and a last entry at least this old means interrupted. */
const INTERRUPTED_AFTER_MS = 120_000;

/** Server rule: "ended" with an ending, else "in-progress" while the last entry is recent. */
function stateOf(conversation: SeedConversation): StoredConversation["state"] {
  if (conversation.endedBy !== null) return "ended";
  return SERVER_NOW - conversation.lastEntryAt < INTERRUPTED_AFTER_MS ? "in-progress" : "interrupted";
}

/**
 * Stands in for the history server's read side as conversation-history-access specifies it:
 * newest first, totals over the whole history (completed = ended by user or agent, failed =
 * by an error; a conversation that was left or has no ending is neither), `state` derived by
 * the server's rule, a deleted conversation gone from the list and unreadable.
 */
function fakeServer(seed: SeedDetail[]) {
  const stored = new Map(seed.map((detail) => [detail.conversation.id, detail]));
  const withState = (conversation: SeedConversation): StoredConversation => ({
    ...conversation,
    state: stateOf(conversation),
  });
  const api: HistoryApi = {
    list: vi.fn(async () => {
      const conversations = [...stored.values()]
        .map((d) => withState(d.conversation))
        .sort((a, b) => b.startedAt - a.startedAt);
      return {
        conversations,
        nextCursor: null,
        totals: {
          all: conversations.length,
          completed: conversations.filter((c) => c.endedBy === "user" || c.endedBy === "agent").length,
          failed: conversations.filter((c) => c.endedBy === "error").length,
        },
      };
    }),
    get: vi.fn(async (id: string) => {
      const detail = stored.get(id);
      if (!detail) throw new Error("404");
      return { ...detail, conversation: withState(detail.conversation) };
    }),
    remove: vi.fn(async (id: string) => {
      if (!stored.delete(id)) throw new Error("404");
    }),
  };
  return api;
}

const older = stored("conv_old", at(24, 18, 20), 134_000, "error", "connection lost");
const newer = stored("conv_new", at(25, 10, 14), 408_000, "user");

const newerDetail: SeedDetail = {
  conversation: newer,
  lines: [
    line(1, "user", "Hi, can you hear me?", 3_000),
    line(2, "agent", "Yes, loud and clear.", 6_000),
  ],
  turns: [turn(1, 9_000, 520, 1080), turn(2, 34_000, 690, 1210), turn(3, 125_000, 1340, 1860), turn(4, 301_000, 480, 990)],
};

const twoConversations = () => fakeServer([{ conversation: older, lines: [], turns: [] }, newerDetail]);

function renderList(api: HistoryApi) {
  render(<HistoryPage api={api} conversationId={null} timeZone="UTC" />);
}

const rows = () => document.querySelectorAll("ol.history-rows > li");

describe("history list", () => {
  it("lists conversations newest first with date, time, length and outcome, and the totals", async () => {
    renderList(twoConversations());

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0].textContent).toContain("Wed 25 Nov");
    expect(rows()[0].textContent).toContain("10:14–10:20");
    expect(rows()[0].textContent).toContain("6:48");
    expect(rows()[0].textContent).toContain("completed");
    expect(rows()[1].textContent).toContain("failed — connection lost");
    const head = document.querySelector(".panel-head")?.textContent ?? "";
    expect(head).toContain("2 sessions");
    expect(head).toContain("1 completed");
    expect(head).toContain("1 failed");
  });

  it("opens a conversation from its date", async () => {
    renderList(twoConversations());

    const link = await screen.findByRole("link", { name: /open conversation of wed 25 nov/i });
    expect(link.getAttribute("href")).toBe("?history=conv_new");
  });

  it("asks before deleting, and Cancel deletes nothing", async () => {
    const api = twoConversations();
    renderList(api);

    fireEvent.click(await screen.findByRole("button", { name: /delete conversation of wed 25 nov/i }));
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Cancel" }));

    expect(api.remove).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
  });

  it("deletes after the confirmation: the row goes and the totals drop", async () => {
    const api = twoConversations();
    renderList(api);

    fireEvent.click(await screen.findByRole("button", { name: /delete conversation of wed 25 nov/i }));
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(api.remove).toHaveBeenCalledWith("conv_new");
    expect(rows()[0].textContent).toContain("Tue 24 Nov");
    expect(document.querySelector(".panel-head")?.textContent).toContain("1 session");
    expect(document.querySelector(".panel-head")?.textContent).not.toContain("1 sessions");
  });
});

/** The three endings that are neither completed nor failed, each as the server's rules derive it. */
const closed = stored("conv_closed", at(25, 8, 0), 130_000, "closed");
const inProgress = storedWithoutEnding("conv_live", at(25, 11, 55), 270_000); // last entry 30 s before SERVER_NOW
const interrupted = storedWithoutEnding("conv_lost", at(25, 9, 2), 185_000); // last entry hours before SERVER_NOW

const unfinishedConversations = () =>
  fakeServer(
    [closed, inProgress, interrupted].map((conversation) => ({
      conversation,
      lines: [line(1, "user", "Hello there", 2_000)],
      turns: [],
    })),
  );

describe("conversations that did not end in completed or failed", () => {
  it("lists a closed one as ended because the visitor left, with its length", async () => {
    renderList(unfinishedConversations());

    await waitFor(() => expect(rows()).toHaveLength(3));
    const row = [...rows()].find((r) => r.getAttribute("data-outcome") === "closed");
    expect(row?.textContent).toContain("08:00–08:02");
    expect(row?.textContent).toContain("2:10");
    expect(row?.textContent).toContain("ended · you left the page");
  });

  it("lists one still receiving entries as in progress, its length running to the last entry", async () => {
    renderList(unfinishedConversations());

    await waitFor(() => expect(rows()).toHaveLength(3));
    const row = [...rows()].find((r) => r.getAttribute("data-outcome") === "in-progress");
    expect(row?.textContent).toContain("11:55");
    expect(row?.textContent).toContain("4:30");
    expect(row?.textContent).toContain("in progress");
  });

  it("lists one whose entries stopped without an ending as interrupted, with its length", async () => {
    renderList(unfinishedConversations());

    await waitFor(() => expect(rows()).toHaveLength(3));
    const row = [...rows()].find((r) => r.getAttribute("data-outcome") === "interrupted");
    expect(row?.textContent).toContain("09:02");
    expect(row?.textContent).toContain("3:05");
    expect(row?.textContent).toContain("interrupted · the ending never arrived");
  });

  it("counts none of them as completed or failed", async () => {
    renderList(unfinishedConversations());

    await waitFor(() => expect(rows()).toHaveLength(3));
    const head = document.querySelector(".panel-head")?.textContent ?? "";
    expect(head).toContain("3 sessions");
    expect(head).toContain("0 completed");
    expect(head).toContain("0 failed");
  });
});

describe("paging the list", () => {
  const totals = { all: 3, completed: 3, failed: 0 };
  const first = stored("conv_first", at(25, 10, 14), 60_000, "user");
  const last = stored("conv_last", at(23, 9, 0), 60_000, "user");

  function pagedServer(firstPageCursor: string | null) {
    const api = twoConversations();
    api.remove = vi.fn(async () => {});
    api.list = vi.fn(async (_signal?: AbortSignal, cursor?: string) =>
      cursor === undefined
        ? { conversations: [{ ...first, state: stateOf(first) }], nextCursor: firstPageCursor, totals }
        : { conversations: [{ ...last, state: stateOf(last) }], nextCursor: null, totals: { all: 99, completed: 99, failed: 0 } },
    );
    return api;
  }

  it("shows older conversations after the first ones when asked, and keeps the first page's totals", async () => {
    const api = pagedServer("cursor_2");
    renderList(api);

    fireEvent.click(await screen.findByRole("button", { name: "Show older conversations" }));

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(api.list).toHaveBeenLastCalledWith(expect.any(AbortSignal), "cursor_2");
    expect(rows()[0].textContent).toContain("Wed 25 Nov");
    expect(rows()[1].textContent).toContain("Mon 23 Nov");
    expect(document.querySelector(".panel-head")?.textContent).toContain("3 sessions");
    expect(screen.queryByRole("button", { name: "Show older conversations" })).toBeNull();
  });

  it("offers no older conversations on the last page", async () => {
    renderList(pagedServer(null));

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Show older conversations" })).toBeNull();
  });

  it("disables the button while loading and offers a retry when it fails", async () => {
    const api = pagedServer("cursor_2");
    const pagedList = api.list;
    let fail: (reason: Error) => void = () => {};
    api.list = vi.fn((signal?: AbortSignal, cursor?: string) =>
      cursor === undefined ? pagedList(signal) : new Promise<ConversationPage>((_resolve, reject) => { fail = reject; }),
    );
    renderList(api);

    const button = await screen.findByRole("button", { name: "Show older conversations" });
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    fail(new Error("offline"));

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(document.querySelector(".history-more-failed")).not.toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it("starts again from the first page after a delete", async () => {
    const api = pagedServer("cursor_2");
    renderList(api);
    fireEvent.click(await screen.findByRole("button", { name: "Show older conversations" }));
    await waitFor(() => expect(rows()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: /delete conversation of mon 23 nov/i }));
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Show older conversations" })).toBeTruthy();
  });
});

describe("deleting one row at a time", () => {
  it("disables the other rows' delete buttons until the pending delete settles", async () => {
    const api = twoConversations();
    let finish: () => void = () => {};
    api.remove = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderList(api);

    fireEvent.click(await screen.findByRole("button", { name: /delete conversation of wed 25 nov/i }));
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Delete" }));

    const other = screen.getByRole("button", { name: /delete conversation of tue 24 nov/i }) as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    finish();

    await waitFor(() => expect(other.disabled).toBe(false));
  });

  it("leaves the other rows' delete buttons enabled while nothing is being deleted", async () => {
    renderList(twoConversations());

    const buttons = await screen.findAllByRole("button", { name: /delete conversation of/i });
    expect(buttons.map((button) => (button as HTMLButtonElement).disabled)).toEqual([false, false]);
  });
});

describe("conversation page", () => {
  function renderConversation(api: HistoryApi, navigate = vi.fn(), conversationId = "conv_new") {
    render(<HistoryPage api={api} conversationId={conversationId} navigate={navigate} timeZone="UTC" />);
    return navigate;
  }

  it("shows when it ran, how it ended, its length and turns", async () => {
    renderConversation(twoConversations());

    expect(await screen.findByRole("heading", { name: "Wed 25 Nov, 10:14–10:20" })).toBeTruthy();
    const meta = document.querySelector(".history-meta")?.textContent ?? "";
    expect(meta).toContain("completed · ended by you");
    expect(meta).toContain("6:48");
    expect(meta).toContain("4");
  });

  it("shows the median turn with the slowest stage called out", async () => {
    renderConversation(twoConversations());

    const median = await screen.findByRole("region", { name: "Median turn" });
    expect(median.querySelector(".breakdown-total")?.textContent).toContain("1145");
    const slowest = median.querySelector('li[data-slowest="true"]');
    expect(slowest?.querySelector(".breakdown-name")?.textContent).toBe("llm");
    expect(slowest?.querySelector(".breakdown-ms")?.textContent).toBe("605");
  });

  it("lists every turn's timings and the whole transcript in order", async () => {
    renderConversation(twoConversations());

    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 4);
    expect(within(table).getAllByRole("row")[3].textContent).toContain("1340");

    const transcript = screen.getByRole("region", { name: "Transcript" });
    const said = [...transcript.querySelectorAll(".line-text")].map((el) => el.textContent);
    expect(said).toEqual(["Hi, can you hear me?", "Yes, loud and clear."]);
    expect(transcript.textContent).toContain("6:48 · you ended the conversation");
  });

  it.each([
    // [server state it imitates, id, label, length, closing line]
    ["ended by closed", "conv_closed", "ended · you left the page", "2:10", "2:10 · you left the page"],
    ["in-progress", "conv_live", "in progress", "4:30", "4:30 · the conversation is still in progress"],
    ["interrupted", "conv_lost", "interrupted · the ending never arrived", "3:05", "3:05 · no ending was recorded"],
  ])("shows a conversation the server calls %s with its label and length", async (_state, id, label, length, closing) => {
    renderConversation(unfinishedConversations(), vi.fn(), id);

    await screen.findByRole("region", { name: "Transcript" });
    const meta = document.querySelector(".history-meta")?.textContent ?? "";
    expect(meta).toContain(label);
    expect(meta).toContain(length);
    expect(screen.getByRole("region", { name: "Transcript" }).textContent).toContain(closing);
  });

  it("deletes after the confirmation and goes back to the list", async () => {
    const api = twoConversations();
    const navigate = renderConversation(api);

    fireEvent.click(await screen.findByRole("button", { name: "Delete conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("?history"));
    expect(api.remove).toHaveBeenCalledWith("conv_new");
  });

  it("deletes nothing when the confirmation is cancelled", async () => {
    const api = twoConversations();
    const navigate = renderConversation(api);

    fireEvent.click(await screen.findByRole("button", { name: "Delete conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(api.remove).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete conversation" })).toBeTruthy();
  });
});

describe("without a history server", () => {
  it("says where history is kept instead of loading anything", () => {
    render(<HistoryPage api={null} conversationId={null} />);
    expect(screen.getByText(/history is kept only where a history server runs/i)).toBeTruthy();
  });
});
