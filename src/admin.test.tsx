import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Admin } from "./Admin";

describe("admin route", () => {
  it("asks for the password before showing anything about keys", async () => {
    render(<Admin />);

    expect(await screen.findByLabelText(/admin password/i)).toBeTruthy();
    expect(screen.queryByText(/issue key/i)).toBeNull();
    expect(screen.queryByText(/active keys/i)).toBeNull();
  });
});
