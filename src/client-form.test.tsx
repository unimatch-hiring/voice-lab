import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClientForm } from "./ClientForm";
import { EMPTY_PROFILE } from "./lib/formModel";

afterEach(cleanup);

describe("ClientForm", () => {
  test("download saves what is in the form as a text file", async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (blobs.push(b), "blob:x"));
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ClientForm value={{ ...EMPTY_PROFILE, name: "Анна" }} lang="en" onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /download form/i }));

    expect(click).toHaveBeenCalled();
    const text = await new Promise<string>((done) => {
      const r = new FileReader();
      r.onload = () => done(r.result as string);
      r.readAsText(blobs[0]);
    });
    expect(text).toMatch(/^Name: Анна\nPhone: \n/);
    click.mockRestore();
  });

  test("shows the value under labels in the requested language", () => {
    render(<ClientForm value={{ ...EMPTY_PROFILE, name: "Иван" }} lang="ru" onChange={() => {}} />);
    expect((screen.getByLabelText(/Имя/) as HTMLInputElement).value).toBe("Иван");
    expect(screen.getByLabelText(/Телефон/)).toBeTruthy();
  });

  test("typing reports the whole next profile", () => {
    const onChange = vi.fn();
    render(<ClientForm value={{ ...EMPTY_PROFILE, name: "Ann" }} lang="en" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Car/), { target: { value: "Kia" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_PROFILE, name: "Ann", car: "Kia" });
  });

  test("an invalid phone shows the localized error; untouched empty fields stay quiet", () => {
    const { rerender } = render(<ClientForm value={EMPTY_PROFILE} lang="ru" onChange={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ClientForm value={{ ...EMPTY_PROFILE, phone: "123" }} lang="ru" onChange={() => {}} />);
    expect(screen.getByRole("alert").textContent).toMatch(/от 10 до 15/);
    rerender(<ClientForm value={{ ...EMPTY_PROFILE, phone: "123" }} lang="en" onChange={() => {}} />);
    expect(screen.getByRole("alert").textContent).toMatch(/10 to 15/);
  });

  test("a required field is flagged once the user leaves it empty", () => {
    render(<ClientForm value={EMPTY_PROFILE} lang="en" onChange={() => {}} />);
    fireEvent.blur(screen.getByLabelText(/Name/));
    expect(screen.getByRole("alert").textContent).toBe("Required");
  });
});
