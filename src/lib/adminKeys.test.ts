import { describe, expect, it, vi } from "vitest";
import { AdminUnauthorized, createAdminClient, formatRemaining } from "./adminKeys";

const URL_BASE = "https://worker.test";

function okJson(body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
}

describe("admin client", () => {
  it("sends the admin password, never the candidate token header", async () => {
    const fetchImpl = okJson({ keys: [] });
    await createAdminClient(URL_BASE, "secret", fetchImpl).list();

    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-admin-token"]).toBe("secret");
    expect(headers["x-vibe-token"]).toBeUndefined();
  });

  it("reports a wrong password distinctly from a broken worker", async () => {
    const unauthorized = vi.fn<typeof fetch>(async () => new Response("{}", { status: 401 }));
    await expect(createAdminClient(URL_BASE, "bad", unauthorized).list()).rejects.toBeInstanceOf(
      AdminUnauthorized,
    );

    const broken = vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 }));
    await expect(createAdminClient(URL_BASE, "ok", broken).list()).rejects.not.toBeInstanceOf(
      AdminUnauthorized,
    );
  });

  it("escapes the token in the revoke path, so a stray character cannot reshape the URL", async () => {
    const fetchImpl = okJson({ revoked: "x" });
    await createAdminClient(URL_BASE, "secret", fetchImpl).revoke("vibe_a/../b");

    expect(fetchImpl.mock.calls[0][0]).toBe(`${URL_BASE}/admin/keys/vibe_a%2F..%2Fb`);
  });
});

describe("remaining time", () => {
  const now = 1_000_000;

  it("counts down in hours and minutes", () => {
    expect(formatRemaining(now + 3 * 3600_000 + 40 * 60_000, now)).toBe("3h 40m left");
  });

  it("drops the hour once under one", () => {
    expect(formatRemaining(now + 25 * 60_000, now)).toBe("25m left");
  });

  it("says expired rather than counting negative", () => {
    expect(formatRemaining(now - 60_000, now)).toBe("expired");
  });
});
