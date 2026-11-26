// @vitest-environment node
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { ValidationError } from "./childService.js";

let server;
let base;
const service = {
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
};

beforeEach(async () => {
  vi.resetAllMocks();
  server = createServer(createApp(service));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
afterEach(() => new Promise((resolve) => server.close(resolve)));

describe("parental HTTP API", () => {
  it("returns the stored settings", async () => {
    service.getSettings.mockResolvedValue({ childProfile: "Masha" });

    const r = await fetch(`${base}/api/settings`);

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ childProfile: "Masha" });
  });

  it("hands the saved body to the service", async () => {
    service.saveSettings.mockImplementation(async (s) => s);

    const r = await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ allowedTopics: "space" }),
    });

    expect(r.status).toBe(200);
    expect(service.saveSettings).toHaveBeenCalledWith({ allowedTopics: "space" });
  });

  it("answers 400 to a body that is not JSON", async () => {
    const r = await fetch(`${base}/api/settings`, { method: "PUT", body: "{" });

    expect(r.status).toBe(400);
    expect(service.saveSettings).not.toHaveBeenCalled();
  });

  it("answers 400 when the service rejects the content", async () => {
    service.saveSettings.mockRejectedValue(new ValidationError("childProfile must be a string"));

    const r = await fetch(`${base}/api/settings`, { method: "PUT", body: "{}" });

    expect(r.status).toBe(400);
  });

  it("answers 404 to anything else", async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });
});
