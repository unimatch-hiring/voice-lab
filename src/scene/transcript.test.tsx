import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { EventBus } from "../lib/events";
import { Transcript } from "./Transcript";

afterEach(cleanup);

function agentRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-who="agent"] .line-text')].map((el) => el.textContent ?? "");
}

test("a reply shown token by token is not shown again when the whole message arrives", () => {
  const bus = new EventBus();
  const { container } = render(<Transcript bus={bus} />);

  act(() => {
    bus.emit({ type: "llm-token", token: "Hello ", at: 0 });
    bus.emit({ type: "llm-token", token: "there", at: 0 });
    bus.emit({ type: "turn-start", at: 0 });
    bus.emit({ type: "agent-reply", text: "Hello there", at: 0, streamed: true });
  });

  expect(agentRows(container)).toEqual(["Hello there"]);
});

test("a reply that only arrived whole gets its own line", () => {
  const bus = new EventBus();
  const { container } = render(<Transcript bus={bus} />);

  act(() => bus.emit({ type: "agent-reply", text: "Hello there", at: 0, streamed: false }));

  expect(agentRows(container)).toEqual(["Hello there"]);
});
