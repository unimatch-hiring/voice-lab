import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { EventBus } from "../lib/events";
import { Transcript } from "./Transcript";

afterEach(cleanup);

test("a late final reply does not repeat text that was already streamed", () => {
  const bus = new EventBus();
  render(<Transcript bus={bus} />);

  act(() => {
    bus.emit({ type: "llm-token", token: "An answer", at: 1 });
    bus.emit({ type: "turn-start", at: 2 });
    bus.emit({ type: "agent-reply", text: "An answer", at: 3, matchesStream: true });
  });

  expect(screen.getAllByText("An answer")).toHaveLength(1);
});

test("a final reply closes the streamed line before another reply arrives", () => {
  const bus = new EventBus();
  render(<Transcript bus={bus} />);

  act(() => {
    bus.emit({ type: "llm-token", token: "First answer", at: 1 });
    bus.emit({ type: "agent-reply", text: "First answer", at: 2, matchesStream: true });
    bus.emit({ type: "llm-token", token: "Second answer", at: 3 });
  });

  expect(screen.getByText("First answer")).toBeTruthy();
  expect(screen.getByText("Second answer")).toBeTruthy();
});
