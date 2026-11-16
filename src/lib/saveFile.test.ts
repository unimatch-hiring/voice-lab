import { afterEach, expect, test, vi } from "vitest";
import { saveFile } from "./saveFile";

afterEach(() => vi.useRealTimers());

test("clicks a link that is in the page and keeps the URL alive past the click", () => {
  vi.useFakeTimers();
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  let seen: { attached: boolean; name: string } | undefined;
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    seen = { attached: document.body.contains(this), name: this.download };
  });

  saveFile("form.txt", "hi");

  expect(seen).toEqual({ attached: true, name: "form.txt" });
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  expect(document.querySelector("a[download]")).toBeNull();
  vi.runAllTimers();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  click.mockRestore();
});
