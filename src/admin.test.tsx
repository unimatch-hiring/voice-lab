import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Admin } from "./Admin";

afterEach(cleanup);

describe("admin route", () => {
  it("asks who is signing in before showing anything about keys", async () => {
    render(<Admin />);

    expect(await screen.findByLabelText(/work email/i)).toBeTruthy();
    expect(screen.queryByText(/issue key/i)).toBeNull();
    expect(screen.queryByText(/active keys/i)).toBeNull();
  });

  it("takes the whole code the Worker sends, not a truncated one", async () => {
    // The Worker went from six digits to eight; a field still capped at six silently ate
    // the last two and every sign-in failed with a code that had just arrived.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    render(<Admin />);

    fireEvent.change(await screen.findByLabelText(/work email/i), {
      target: { value: "stas@unimatch.ai" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send me a code/i }));

    const field = await screen.findByLabelText(/code from slack/i);
    fireEvent.change(field, { target: { value: "40680429" } });

    expect((field as HTMLInputElement).value).toBe("40680429");
    expect(screen.getByRole("button", { name: /sign in/i }).hasAttribute("disabled")).toBe(false);
  });
});
