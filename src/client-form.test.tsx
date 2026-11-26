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
    render(<ClientForm value={{ ...EMPTY_PROFILE, name: "Анна" }} lang="en" onChange={() => {}} onClear={() => {}} />);

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
    render(<ClientForm value={{ ...EMPTY_PROFILE, name: "Иван" }} lang="ru" onChange={() => {}} onClear={() => {}} />);
    expect((screen.getByLabelText(/Имя/) as HTMLInputElement).value).toBe("Иван");
    expect(screen.getByLabelText(/Телефон/)).toBeTruthy();
  });

  test("typing reports the whole next profile", () => {
    const onChange = vi.fn();
    render(<ClientForm value={{ ...EMPTY_PROFILE, name: "Ann" }} lang="en" onChange={onChange} onClear={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Car/), { target: { value: "Kia" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_PROFILE, name: "Ann", car: "Kia" });
  });

  test("an invalid phone shows the localized error; untouched empty fields stay quiet", () => {
    const { rerender } = render(<ClientForm value={EMPTY_PROFILE} lang="ru" onChange={() => {}} onClear={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ClientForm value={{ ...EMPTY_PROFILE, phone: "123" }} lang="ru" onChange={() => {}} onClear={() => {}} />);
    expect(screen.getByRole("alert").textContent).toMatch(/от 10 до 15/);
    rerender(<ClientForm value={{ ...EMPTY_PROFILE, phone: "123" }} lang="en" onChange={() => {}} onClear={() => {}} />);
    expect(screen.getByRole("alert").textContent).toMatch(/10 to 15/);
  });

  test("the service is the agent's to set: shown last as text, not editable", () => {
    const service = "Замена масла и фильтра, проверка тормозных колодок";
    render(<ClientForm value={{ ...EMPTY_PROFILE, service }} lang="en" onChange={() => {}} onClear={() => {}} />);
    expect(screen.queryByRole("textbox", { name: /Service/ })).toBeNull();
    const block = screen.getByRole("region", { name: "Service" });
    expect(block.textContent).toContain(service);
    expect(block.nextElementSibling?.className).toBe("form-actions");
  });

  test("clear profile sits beside download, in the form's language, and asks the page to clear", () => {
    const onClear = vi.fn();
    const { rerender } = render(<ClientForm value={EMPTY_PROFILE} lang="ru" onChange={() => {}} onClear={onClear} />);
    const clear = screen.getByRole("button", { name: "Очистить профиль" });
    expect(clear.previousElementSibling?.textContent).toBe("download form");
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
    rerender(<ClientForm value={EMPTY_PROFILE} lang="en" onChange={() => {}} onClear={onClear} />);
    expect(screen.getByRole("button", { name: "Clear profile" })).toBeTruthy();
  });

  test("clearing leaves no \"required\" under the fields that were emptied", () => {
    render(<ClientForm value={EMPTY_PROFILE} lang="en" onChange={() => {}} onClear={() => {}} />);
    fireEvent.blur(screen.getByLabelText(/Name/));
    fireEvent.click(screen.getByRole("button", { name: "Clear profile" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a required field is flagged once the user leaves it empty", () => {
    render(<ClientForm value={EMPTY_PROFILE} lang="en" onChange={() => {}} onClear={() => {}} />);
    fireEvent.blur(screen.getByLabelText(/Name/));
    expect(screen.getByRole("alert").textContent).toBe("Required");
  });
});
