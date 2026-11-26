import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EventBus } from "../lib/events";
import { Transcript } from "./Transcript";

afterEach(cleanup);

test("download saves the conversation on screen as a text file", async () => {
  const blobs: Blob[] = [];
  URL.createObjectURL = vi.fn((b: Blob) => (blobs.push(b), "blob:x"));
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const bus = new EventBus();
  render(<Transcript bus={bus} />);

  act(() => {
    bus.emit({ type: "stt-result", result: { text: "меня зовут Анна", words: [] } });
    bus.emit({ type: "agent-reply", text: "Здравствуйте, Анна.", at: 0 });
  });
  fireEvent.click(screen.getByRole("button", { name: /download/i }));

  expect(click).toHaveBeenCalled();
  expect(await readText(blobs[0])).toBe("you: меня зовут Анна\nagent: Здравствуйте, Анна.\n");
});

test("agent lines mark tool data as fact and guesses as assumption, with a legend", () => {
  const bus = new EventBus();
  const { container } = render(<Transcript bus={bus} />);

  act(() => {
    bus.emit({ type: "tool-result", name: "search_services", facts: ["Замена масла", "2500", "30"] });
    bus.emit({ type: "llm-token", token: "Замена масла стоит 2", at: 0 });
    bus.emit({ type: "llm-token", token: " 500 ₽, займёт примерно 50 минут.", at: 1 });
  });

  const text = (sel: string) => [...container.querySelectorAll(`.line-text ${sel}`)].map((n) => n.textContent);
  expect(text(".mark-fact")).toEqual(["Замена масла", "2 500 ₽"]);
  expect(text(".mark-assumption")).toEqual(["примерно", "50 минут"]);
  expect(container.querySelector('.line[data-who="agent"] .line-text')?.textContent).toBe("Замена масла стоит 2 500 ₽, займёт примерно 50 минут.");
  expect(container.querySelector(".transcript-legend .mark-fact")?.textContent).toBe("fact — from the prompt or a tool");
  expect(container.querySelector(".transcript-legend .mark-assumption")?.textContent).toMatch(/assumption/);
});

test("a reply quoting the shop's hours is marked as fact before any tool runs", () => {
  const bus = new EventBus();
  const { container } = render(<Transcript bus={bus} />);

  act(() => bus.emit({ type: "agent-reply", text: "АвтоЛаб открыт с понедельника по субботу, 09:00–19:00.", at: 0 }));

  const text = (sel: string) => [...container.querySelectorAll(`.line-text ${sel}`)].map((n) => n.textContent);
  expect(text(".mark-fact")).toEqual(["АвтоЛаб", "09:00", "19:00"]);
  expect(text(".mark-assumption")).toEqual([]);
});

test("each tool call gets its own row, an empty one included", () => {
  const bus = new EventBus();
  const { container } = render(<Transcript bus={bus} />);

  act(() => {
    bus.emit({ type: "tool-result", name: "update_form", facts: ["Пётр"] });
    bus.emit({ type: "tool-result", name: "find_slots", facts: [] });
  });

  const rows = [...container.querySelectorAll('.line[data-who="tool"] .line-text')].map((n) => n.textContent);
  expect(rows).toEqual(["update_form → Пётр", "find_slots → nothing found"]);
});

// jsdom's Blob has no .text(); FileReader is the jsdom-native way in.
const readText = (b: Blob) =>
  new Promise<string>((done) => {
    const r = new FileReader();
    r.onload = () => done(r.result as string);
    r.readAsText(b);
  });

test("a price from the prompt's price list is a fact with no tool call behind it", () => {
  const bus = new EventBus();
  const { container } = render(<Transcript bus={bus} />);
  act(() => bus.emit({ type: "llm-token", token: "Замена масла стоит 2500 ₽.", at: 0 }));
  const facts = [...container.querySelectorAll(".line-text .mark-fact")].map((n) => n.textContent);
  expect(facts).toEqual(["Замена масла", "2500 ₽"]);
});
