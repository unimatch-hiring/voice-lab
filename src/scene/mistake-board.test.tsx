import { expect, test, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { MistakeBoard } from "./MistakeBoard";
import { EventBus } from "../lib/events";

afterEach(cleanup);

function board() {
  const bus = new EventBus();
  const onClear = vi.fn();
  render(<MistakeBoard bus={bus} onClear={onClear} />);
  const log = screen.getByLabelText(/mistakes and their corrections/i) as HTMLTextAreaElement;
  // Wrapped: the button's enabled state is React state, so the event has to be
  // flushed like any other update.
  const said = (said: string, fixed: string, total: number) =>
    act(() =>
      bus.emit({ type: "mistake", said, fixed, labels: ["to + infinitive"], total, at: 0 }),
    );
  const clear = () => screen.getByRole("button", { name: /clear/i }) as HTMLButtonElement;
  return { bus, log, said, onClear, clear };
}

test("a mistake is shown as what was said against what English wants", () => {
  const { log, said } = board();

  said("i like listen radio", "I like to listen to the radio", 1);

  expect(log.value).toBe("i like listen radio -> I like to listen to the radio");
});

test("mistakes accumulate, newest last", () => {
  const { log, said } = board();

  said("i like listen radio", "I like to listen to the radio", 1);
  said("she have two cats", "She has two cats", 2);

  expect(log.value.split("\n")).toEqual([
    "i like listen radio -> I like to listen to the radio",
    "she have two cats -> She has two cats",
  ]);
});

test("the count comes from the log rather than from counting lines", () => {
  const { said } = board();

  said("she have two cats", "She has two cats", 7);

  // 7 because six were made before this page was open — the board renders the
  // tutor's tally, so a restored lesson does not read as starting from one.
  expect(screen.getByText("7")).toBeTruthy();
});

test("the record is read-only: it is a record, not an input", () => {
  const { log } = board();
  expect(log.readOnly).toBe(true);
});

test("an empty board says what will appear in it", () => {
  const { log } = board();
  expect(log.value).toBe("");
  expect(log.placeholder).toMatch(/nothing corrected yet/i);
});

test("nothing else on the bus reaches the board", () => {
  const { bus, log } = board();

  bus.emit({ type: "stt-result", result: { text: "i like listen radio", words: [] } });
  bus.emit({ type: "agent-reply", text: "You should say: I like to listen", at: 0 });

  expect(log.value, "only the tutor's verdict belongs here").toBe("");
});

test("there is nothing to clear until there is something", () => {
  const { clear, said } = board();
  expect(clear().disabled, "an empty record offers no button to press").toBe(true);

  said("she have two cats", "She has two cats", 1);
  expect(clear().disabled).toBe(false);
});

test("clearing empties the list and zeroes the count", () => {
  const { bus, log, said, clear, onClear } = board();

  said("she have two cats", "She has two cats", 1);
  said("he go home", "He goes home", 2);
  expect(screen.getByText("2")).toBeTruthy();

  fireEvent.click(clear());
  expect(onClear, "the tutor is asked to do it, not the board").toHaveBeenCalledTimes(1);

  // The board empties when the tutor says it is done, not on the click: the record
  // lives in the tutor and the store, and the screen follows it.
  expect(log.value, "still showing until then").not.toBe("");
  act(() => bus.emit({ type: "mistakes-cleared", at: 0 }));

  expect(log.value).toBe("");
  expect(screen.getByText("0")).toBeTruthy();
  expect(clear().disabled, "and nothing left to clear").toBe(true);
});

test("counting again after a clear starts from the tutor's count", () => {
  const { bus, log, said } = board();

  said("she have two cats", "She has two cats", 1);
  act(() => bus.emit({ type: "mistakes-cleared", at: 0 }));
  said("he go home", "He goes home", 1);

  expect(log.value).toBe("he go home -> He goes home");
  expect(screen.getByText("1")).toBeTruthy();
});

test("renders do not track the stream of mistakes", () => {
  // The repo rule is that renders must not follow the event stream. Crossing from an
  // empty record to a non-empty one is a render — the clear button has to become
  // pressable — but the fiftieth mistake must cost nothing.
  let renders = 0;
  const bus = new EventBus();
  const Counted = (props: { bus: EventBus; onClear: () => void }) => {
    renders++;
    return MistakeBoard(props);
  };
  render(<Counted bus={bus} onClear={() => {}} />);
  const initial = renders;

  act(() => {
    for (let i = 0; i < 50; i++) {
      bus.emit({
        type: "mistake",
        said: "she have a cat",
        fixed: "She has a cat",
        labels: ["he/she + verb-s"],
        total: i + 1,
        at: i,
      });
    }
    bus.emit({ type: "mistakes-cleared", at: 0 });
  });

  // Two crossings: empty to filled, and back to empty.
  expect(renders - initial).toBeLessThanOrEqual(2);
});
