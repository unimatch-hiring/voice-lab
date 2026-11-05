import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Transcript } from "./Transcript";
import { EventBus } from "../lib/events";
import type { PipelineEvent } from "../lib/types";

afterEach(cleanup);

function setup() {
  const bus = new EventBus();
  const { container } = render(<Transcript bus={bus} />);
  const emit = (...events: PipelineEvent[]) => act(() => events.forEach((e) => bus.emit(e)));
  const rows = (who: string) => [...container.querySelectorAll(`.line[data-who="${who}"] .line-text`)];
  return { bus, container, emit, rows };
}

const reply = (text: string): PipelineEvent => ({ type: "agent-reply", text, at: 0 });
const token = (text: string): PipelineEvent => ({ type: "llm-token", token: text, at: 0 });
const heard = (text: string): PipelineEvent => ({ type: "stt-result", result: { text, words: [] } });

const css = () => readFileSync(resolve(process.cwd(), "src/scene/tokens.css"), "utf8");
const FACT = "По прайс-листу, подписка на месяц стоит 120 долларов.";

test("a wrong figure under a real source is shown as unverified", () => {
  const { container, emit, rows } = setup();
  const text = "По прайс-листу, подписка на месяц стоит 90 долларов.";

  emit(reply(text));

  expect(container.querySelector('[data-claim="fact"]')).toBeNull();
  expect(container.querySelector('[data-claim="unverified"]')?.textContent).toBe(text);
  expect(rows("agent")[0].textContent).toBe(text);
});

test("masking a word never turns a sentence into a directory match", () => {
  const { container, emit, rows } = setup();

  emit(reply("По прайс-листу, годовой абонемент стоит 1000 ебаных долларов."));

  expect(container.querySelector('[data-claim="fact"]')).toBeNull();
  expect(container.querySelector('[data-claim="unverified"]')).not.toBeNull();
  expect(rows("agent")[0].textContent).toBe(
    "По прайс-листу, годовой абонемент стоит 1000 ****** долларов.",
  );
});

test("an unverified claim says so on screen", () => {
  const line = (claim: string) =>
    new RegExp(`\\[data-claim="${claim}"\\][^{]*\\{[^}]*border-bottom-style:\\s*([a-z]+)`).exec(css())?.[1];

  expect(css()).toMatch(/\[data-claim="unverified"\]::after\s*\{[^}]*content:\s*"[^"]*не подтверждено/);
  expect(line("unverified")).toBeTruthy();
  expect(line("unverified")).not.toBe(line("fact"));
  expect(line("unverified")).not.toBe(line("assumption"));
});

test("the person's lines, facts, assumptions and unverified claims each have a colour", () => {
  const colourOf = (selector: string) => {
    const escaped = selector.replace(/[[\]"=.]/g, "\\$&");
    const rule = new RegExp(`${escaped}[^{]*\\{[^}]*?[;\\s]color:\\s*var\\((--[a-z-]+)\\)`).exec(css());
    return rule?.[1];
  };
  const tokenValue = (name: string) =>
    new RegExp(`${name}:\\s*(#[0-9a-f]{3,8})`, "i").exec(css())?.[1]?.toLowerCase();

  const names = [
    colourOf('.line[data-who="you"] .line-text'),
    colourOf('[data-claim="fact"]'),
    colourOf('[data-claim="assumption"]'),
    colourOf('[data-claim="unverified"]'),
  ];
  for (const name of names) expect(name, names.join()).toBeTruthy();

  const values = names.map((name) => tokenValue(name as string));
  for (const value of values) expect(value, names.join()).toBeTruthy();
  expect(new Set(values).size, values.join()).toBe(4);

  // A claim the directory does not back must not read as a failure of the pipeline.
  for (const fail of css().matchAll(/--fail:\s*(#[0-9a-f]{3,8})/gi)) {
    expect(values).not.toContain(fail[1].toLowerCase());
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(fail[1].slice(i, i + 2), 16));
    expect(r > g && r > b, "--fail is expected to be red").toBe(true);
  }
  const unverified = values[3] as string;
  const blue = parseInt(unverified.slice(5, 7), 16);
  const green = parseInt(unverified.slice(3, 5), 16);
  expect(blue, "unverified sits away from the red of a failure").toBeGreaterThan(green);
});

test("a legend names each colour", () => {
  const { container } = setup();
  const legend = (key: string) => container.querySelector(`.transcript-legend .legend-${key}`);

  for (const key of ["you", "fact", "assumption", "unverified"]) {
    expect(legend(key), key).not.toBeNull();
    expect(legend(key)?.textContent, key).not.toBe("");
    expect(css(), key).toMatch(new RegExp(`\\.legend-${key}[^{]*\\{|\\.legend-${key}\\s*,`));
  }

  // The line and the legend have to name the status the same way to be matched by eye.
  const note = /\[data-claim="unverified"\]::after\s*\{[^}]*content:\s*" \(([^)]+)\)"/.exec(css())?.[1];
  expect(legend("unverified")?.textContent).toBe(note);
});

test("a finished reply shows facts and assumptions as distinct claims", () => {
  const { container, emit, rows } = setup();
  const text = `${FACT} Думаю, год выгоднее. Хотите записаться?`;

  emit(reply(text));

  expect(rows("agent")[0].textContent).toBe(text);
  const facts = container.querySelectorAll('[data-claim="fact"]');
  const assumptions = container.querySelectorAll('[data-claim="assumption"]');
  expect(facts).toHaveLength(1);
  expect(facts[0].getAttribute("data-source")).toBe("price-list");
  expect(facts[0].textContent).toBe(`${FACT} `);
  expect(assumptions).toHaveLength(1);
  expect(assumptions[0].hasAttribute("data-source")).toBe(false);
  expect(assumptions[0].textContent).toBe("Думаю, год выгоднее. ");
});

test("a final text replaces the streamed line and is the one highlighted", () => {
  for (const final of [FACT, "По прайс-листу, годовой абонемент стоит 1000 долларов."]) {
    const { container, emit, rows } = setup();

    emit(token("По пр"), token("айс-листу, подписка на месяц стоит 120 долларов."));
    expect(container.querySelector("[data-claim]"), "no highlight while streaming").toBeNull();
    emit(reply(final));

    expect(rows("agent"), final).toHaveLength(1);
    expect(rows("agent")[0].textContent).toBe(final);
    expect(container.querySelector('[data-claim="fact"]')?.textContent).toBe(final);
    cleanup();
  }
});

test("facts and assumptions differ by more than colour", () => {
  const style = (claim: string) =>
    new RegExp(`\\[data-claim="${claim}"\\][^{]*\\{[^}]*border-bottom-style:\\s*([a-z]+)`).exec(css())?.[1];

  expect(style("fact")).toBeTruthy();
  expect(style("assumption")).toBeTruthy();
  expect(style("fact")).not.toBe(style("assumption"));
});

test("two streamed replies stay on two lines", () => {
  const { emit, rows } = setup();

  emit(token("первая"), reply("первая"), token("вторая"));
  expect(rows("agent")[1].textContent, "the first reply does not leak into the stream").toBe("вторая");

  emit(reply("вторая"));
  expect(rows("agent").map((r) => r.textContent)).toEqual(["первая", "вторая"]);
});

test("an empty final text neither adds a line nor erases the stream", () => {
  const { emit, rows } = setup();

  emit(reply("  "));
  expect(rows("agent"), "no blank line").toHaveLength(0);

  emit(token("ответ"), reply(""), token("новая"));
  expect(rows("agent").map((r) => r.textContent)).toEqual(["ответ", "новая"]);
});

test("a new turn starts its stream from an empty line", () => {
  const { emit, rows } = setup();

  emit(token("обрыв"), { type: "turn-start", at: 0 } as PipelineEvent, token("новая"));

  expect(rows("agent").map((r) => r.textContent)).toEqual(["обрыв", "новая"]);
});

test("a reply without a stream stays scrolled into view", () => {
  const { container, emit } = setup();
  const list = container.querySelector(".transcript-lines") as HTMLElement;
  // jsdom has no layout, so the height is derived from what the list holds right now.
  Object.defineProperty(list, "scrollHeight", { get: () => (list.textContent ?? "").length });

  emit(reply(FACT));

  expect(list.scrollTop).toBe(list.scrollHeight);
});

test("the person's words are not parsed as claims", () => {
  const { container, emit, rows } = setup();

  emit(heard(FACT));

  expect(rows("you")[0].textContent).toBe(FACT);
  expect(container.querySelector("[data-claim]")).toBeNull();
});

test("an error message is not parsed as claims", () => {
  const { container, emit, rows } = setup();

  emit({ type: "stage-error", stage: "stt", at: 0, message: `boom. ${FACT}` });

  expect(rows("agent")[0].textContent).toBe(`stt failed: boom. ${FACT}`);
  expect(container.querySelector("[data-claim]")).toBeNull();
});

test("model text never becomes markup", () => {
  const { container, emit, rows } = setup();
  const text = "По прайс-листу, <img src=x>. Думаю, <img src=x>. Хотите <img src=x>?";

  emit(reply(text));

  expect(container.querySelector("img")).toBeNull();
  expect(rows("agent")[0].textContent).toBe(text);
});

test("a reply renders without a React render", () => {
  const bus = new EventBus();
  let renders = 0;
  const Counted = (props: { bus: EventBus }) => {
    renders++;
    return Transcript(props);
  };
  render(<Counted bus={bus} />);
  const initial = renders;

  act(() => {
    for (let i = 0; i < 60; i++) bus.emit(token("сло"));
    bus.emit(reply(FACT));
    bus.emit(heard("спасибо"));
  });

  expect(renders).toBe(initial);
});

test("profanity in the person's line is shown as asterisks", () => {
  const { bus, emit, rows } = setup();
  const seen: PipelineEvent[] = [];
  bus.on((e) => seen.push(e));

  emit(heard("ну ты мудак, честно"));

  expect(rows("you")[0].textContent).toBe("ну ты *****, честно");
  expect(seen[0], "the bus and the recorder keep the original").toEqual(heard("ну ты мудак, честно"));
});

test("profanity in the agent's line is masked while streaming and when final", () => {
  const { container, emit, rows } = setup();

  emit(token("это му"), token("дак"));
  expect(rows("agent")[0].textContent).toBe("это *****");

  emit(reply(`${FACT} Это мудак.`));
  expect(rows("agent")[0].textContent).toBe(`${FACT} Это *****.`);
  expect(container.querySelector('[data-claim="fact"]')?.textContent).toBe(`${FACT} `);
});
