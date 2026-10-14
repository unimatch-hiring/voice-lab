import { expect, test, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { LevelLine } from "./LevelLine";
import { EventBus } from "../lib/events";

afterEach(cleanup);

function line() {
  const bus = new EventBus();
  const onReset = vi.fn();
  render(<LevelLine bus={bus} onReset={onReset} />);
  // The line keeps the level in state, so the event has to be flushed like any other
  // React update.
  const announce = (level: string | null, told = true) =>
    act(() => bus.emit({ type: "level", level, told, at: 0 }));
  return { bus, onReset, announce };
}

test("with no level the line says one will be asked for", () => {
  line();
  expect(screen.getByText(/not set/i)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /reset level/i }),
    "nothing to reset yet",
  ).toBeNull();
});

test("a level the learner gave is shown as theirs", () => {
  const { announce } = line();
  announce("B1", true);

  expect(screen.getByText("B1")).toBeTruthy();
  expect(screen.getByText(/you said so/i)).toBeTruthy();
});

test("a level we guessed says so", () => {
  // The caveat is the point: four sentences is not an exam, and the line must not
  // read like one.
  const { announce } = line();
  announce("B1", false);

  expect(screen.getByText(/from how you speak/i)).toBeTruthy();
});

test("resetting asks the tutor to forget it", () => {
  const { announce, onReset } = line();
  announce("B2", true);

  fireEvent.click(screen.getByRole("button", { name: /reset level/i }));

  expect(onReset).toHaveBeenCalledTimes(1);
});

test("once reset, the line is back to asking", () => {
  const { announce } = line();
  announce("B2", true);
  announce(null);

  expect(screen.getByText(/not set/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /reset level/i })).toBeNull();
});
