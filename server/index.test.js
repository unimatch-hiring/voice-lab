// @vitest-environment node
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createRequestListener, handleListenError, MAX_BODY_BYTES, sendResponse, toRequest,
} from "./index.js";

function fakeIncoming({ method, url, headers, body = "" }) {
  const incoming = Readable.from(body === "" ? [] : [Buffer.from(body)]);
  return Object.assign(incoming, { method, url, headers });
}

function fakeOutgoing() {
  return {
    headersSent: false,
    writeHead: vi.fn(function writeHead() { this.headersSent = true; }),
    end: vi.fn(),
    destroy: vi.fn(),
  };
}

describe("toRequest", () => {
  it("keeps the method, URL, headers and body", async () => {
    const request = await toRequest(fakeIncoming({
      method: "POST",
      url: "/conversations?cursor=abc",
      headers: { host: "127.0.0.1:8788", "content-type": "application/json", "x-history-user": "u" },
      body: '{"agentId":"a"}',
    }));

    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://127.0.0.1:8788/conversations?cursor=abc");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("x-history-user")).toBe("u");
    expect(await request.text()).toBe('{"agentId":"a"}');
  });

  it("joins a body that arrives in several chunks", async () => {
    const incoming = Object.assign(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), {
      method: "POST", url: "/", headers: { host: "h" },
    });
    expect(await (await toRequest(incoming)).text()).toBe("abcd");
  });

  it("gives GET no body, even when the stream has bytes", async () => {
    const request = await toRequest(fakeIncoming({
      method: "GET", url: "/conversations", headers: { host: "h" }, body: "ignored",
    }));
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
  });

  it("keeps every value of a repeated header", async () => {
    const request = await toRequest(fakeIncoming({
      method: "GET", url: "/", headers: { host: "h", "x-seen": ["a", "b"] },
    }));
    expect(request.headers.get("x-seen")).toBe("a, b");
  });
});

describe("sendResponse", () => {
  it("writes status, headers and body", async () => {
    const outgoing = fakeOutgoing();
    await sendResponse(outgoing, new Response('{"ok":true}', {
      status: 201, headers: { "content-type": "application/json", "x-extra": "1" },
    }));

    expect(outgoing.writeHead).toHaveBeenCalledWith(201, {
      "content-type": "application/json", "x-extra": "1",
    });
    expect(outgoing.end).toHaveBeenCalledWith(Buffer.from('{"ok":true}'));
  });

  it("ends with an empty body for a 204", async () => {
    const outgoing = fakeOutgoing();
    await sendResponse(outgoing, new Response(null, { status: 204 }));

    expect(outgoing.writeHead).toHaveBeenCalledWith(204, {});
    expect(outgoing.end).toHaveBeenCalledWith(Buffer.alloc(0));
  });
});

describe("createRequestListener", () => {
  const incoming = () => fakeIncoming({ method: "GET", url: "/", headers: { host: "h" } });

  it("answers what the app returns", async () => {
    const outgoing = fakeOutgoing();
    await createRequestListener(async () => new Response("hi", { status: 200 }))(incoming(), outgoing);

    expect(outgoing.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(outgoing.end).toHaveBeenCalledWith(Buffer.from("hi"));
  });

  it("answers 500 and logs when the app throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const outgoing = fakeOutgoing();
    await createRequestListener(async () => { throw new Error("boom"); })(incoming(), outgoing);

    expect(outgoing.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(outgoing.end).toHaveBeenCalledWith(Buffer.from('{"error":"internal error"}'));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  describe("body size cap", () => {
    const postOf = (body, headers = {}) => fakeIncoming({
      method: "POST", url: "/conversations", headers: { host: "h", ...headers }, body,
    });

    it("answers 413 and never calls the app for a body one byte over the cap", async () => {
      const app = vi.fn(async () => new Response("stored"));
      const outgoing = fakeOutgoing();
      await createRequestListener(app)(postOf("x".repeat(MAX_BODY_BYTES + 1)), outgoing);

      expect(app).not.toHaveBeenCalled();
      expect(outgoing.writeHead).toHaveBeenCalledWith(413, expect.objectContaining({ connection: "close" }));
      expect(outgoing.end).toHaveBeenCalledWith(Buffer.from('{"error":"body too large"}'));
    });

    it("answers 413 on content-length alone, without reading the body", async () => {
      const app = vi.fn(async () => new Response("stored"));
      const incoming = postOf("{}", { "content-length": String(MAX_BODY_BYTES + 1) });
      const outgoing = fakeOutgoing();
      await createRequestListener(app)(incoming, outgoing);

      expect(app).not.toHaveBeenCalled();
      expect(outgoing.writeHead).toHaveBeenCalledWith(413, expect.any(Object));
      expect(incoming.readableDidRead).toBe(false);
    });

    it("stops reading at the first chunk past the cap", async () => {
      const chunks = [Buffer.alloc(MAX_BODY_BYTES), Buffer.alloc(1), Buffer.alloc(1)];
      const incoming = Object.assign(Readable.from(chunks, { objectMode: false }), {
        method: "POST", url: "/", headers: { host: "h" },
      });
      await expect(toRequest(incoming)).rejects.toThrow("over");
      expect(incoming.destroyed).toBe(false);
    });

    it("hands a JSON body of exactly the cap to the app", async () => {
      const prefix = '{"text":"';
      const suffix = '"}';
      const body = prefix + "x".repeat(MAX_BODY_BYTES - prefix.length - suffix.length) + suffix;
      expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES);
      const app = vi.fn(async (request) => new Response(String((await request.text()).length), { status: 200 }));
      const outgoing = fakeOutgoing();
      await createRequestListener(app)(postOf(body, { "content-length": String(MAX_BODY_BYTES) }), outgoing);

      expect(app).toHaveBeenCalledOnce();
      expect(outgoing.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(outgoing.end).toHaveBeenCalledWith(Buffer.from(String(MAX_BODY_BYTES)));
    });
  });
});

describe("handleListenError", () => {
  it("names the port and PORT on one line, then exits non-zero when the port is taken", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    handleListenError(Object.assign(new Error("in use"), { code: "EADDRINUSE" }), 8788, exit);

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toMatch(/^[^\n]*8788[^\n]*PORT[^\n]*$/);
    expect(exit).toHaveBeenCalledWith(1);
    error.mockRestore();
  });

  it("rethrows any other listen error", () => {
    const exit = vi.fn();
    const failure = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(() => handleListenError(failure, 80, exit)).toThrow(failure);
    expect(exit).not.toHaveBeenCalled();
  });
});
