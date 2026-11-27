import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryApiError, REQUEST_TIMEOUT_MS, createHistoryApi } from "./historyApi";

const USER_ID = "3f2b8c1e-5d4a-4b7e-9a60-1c2d3e4f5a6b";

function apiAnswering(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  return { fetch, api: createHistoryApi({ historyUrl: "http://history.test", userId: USER_ID, fetch }) };
}

/** A fetch that never answers, and rejects the way the real one does when its signal aborts. */
function silentServer() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  return { fetch, api: createHistoryApi({ historyUrl: "http://history.test", userId: USER_ID, fetch }) };
}

afterEach(() => vi.useRealTimers());

describe("history read client", () => {
  it("lists with the user id in a header, never in the URL", async () => {
    const page = { conversations: [], nextCursor: null, totals: { all: 0, completed: 0, failed: 0 } };
    const { fetch, api } = apiAnswering(new Response(JSON.stringify(page)));

    expect(await api.list()).toEqual(page);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://history.test/conversations");
    expect(String(url)).not.toContain(USER_ID);
    expect(new Headers(init?.headers).get("x-history-user")).toBe(USER_ID);
  });

  it("encodes the conversation id into the path", async () => {
    const { fetch, api } = apiAnswering(new Response("{}"));
    await api.get("conv/1 2");
    expect(fetch.mock.calls[0][0]).toBe("http://history.test/conversations/conv%2F1%202");
  });

  it("deletes with DELETE and accepts the empty 204", async () => {
    const { fetch, api } = apiAnswering(new Response(null, { status: 204 }));
    await api.remove("c1");
    expect(fetch.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("rejects when the server answers with an error status", async () => {
    const { api } = apiAnswering(new Response("{}", { status: 404 }));
    await expect(api.get("missing")).rejects.toBeInstanceOf(HistoryApiError);
  });

  it("asks for the page after a cursor, encoded", async () => {
    const { fetch, api } = apiAnswering(new Response("{}"));
    await api.list(undefined, "a b/c");
    expect(fetch.mock.calls[0][0]).toBe("http://history.test/conversations?cursor=a%20b%2Fc");
  });

  describe("time limit", () => {
    it("rejects a request the server never answers once the limit passes", async () => {
      vi.useFakeTimers();
      const { api } = silentServer();

      const settled = vi.fn();
      const listed = api.list().catch(settled);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await listed;

      expect(settled).toHaveBeenCalledTimes(1);
    });

    it("limits deletes and single reads the same way", async () => {
      vi.useFakeTimers();
      const { api } = silentServer();

      const removed = expect(api.remove("c1")).rejects.toBeDefined();
      const read = expect(api.get("c1")).rejects.toBeDefined();
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

      await removed;
      await read;
    });

    it("still aborts as soon as the caller does", async () => {
      vi.useFakeTimers();
      const { api } = silentServer();
      const caller = new AbortController();

      const listed = api.list(caller.signal);
      caller.abort(new Error("navigated away"));

      await expect(listed).rejects.toThrow("navigated away");
    });

    it("aborts a request whose caller was already gone", async () => {
      vi.useFakeTimers();
      const { api } = silentServer();
      const caller = new AbortController();
      caller.abort(new Error("navigated away"));

      await expect(api.list(caller.signal)).rejects.toThrow("navigated away");
    });

    it("clears its timer and listener once the answer is in", async () => {
      vi.useFakeTimers();
      const { fetch, api } = apiAnswering(new Response("{}"));
      const caller = new AbortController();

      await api.list(caller.signal);

      expect(vi.getTimerCount()).toBe(0);
      const sent = fetch.mock.calls[0][1]?.signal;
      caller.abort();
      expect(sent?.aborted).toBe(false);
    });
  });
});
