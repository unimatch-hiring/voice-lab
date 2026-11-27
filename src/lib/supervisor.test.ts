import { expect, test } from "vitest";
import { EventBus } from "./events";
import { EMPTY_PROFILE, type ClientProfile } from "./formModel";
import { extractFields, supervise } from "./supervisor";

test("phone, plate and name come out of a spoken line", () => {
  expect(extractFields("Меня зовут анна, номер А123ВС77, телефон +7 900 123-45-67")).toEqual({
    name: "Анна",
    plate: "А123ВС77",
    phone: "+7 900 123-45-67",
  });
  expect(extractFields("my name is John, call 8 916 555 12 34")).toEqual({ name: "John", phone: "8 916 555 12 34" });
  expect(extractFields("хочу поменять масло завтра в 10")).toEqual({});
});

test("a phone stops at its tenth digit, so the date or price said after it stays out", () => {
  expect(extractFields("89001234567 20 ноября")).toEqual({ phone: "89001234567" });
  expect(extractFields("телефон 8 916 555 12 34 2 500 рублей")).toEqual({ phone: "8 916 555 12 34" });
});

test("only Russian phone shapes are read as a phone", () => {
  expect(extractFields("+7 (900) 123-45-67")).toEqual({ phone: "+7 (900) 123-45-67" });
  expect(extractFields("8(900)123-45-67")).toEqual({ phone: "8(900)123-45-67" });
  expect(extractFields("9001234567")).toEqual({ phone: "9001234567" });
  for (const text of [
    "сумма 1500 2800 3500",
    "в 10 30 2025 11 20",
    "сумма 1500 900 300 20 00",
    "телефон 890012345678",
    "заказ 12345678901",
    "номер 12345678901234567890",
    "телефон 900 123 45 6",
    "12.11.2026 в 10:30",
    "2500 рублей",
    "2 500 / 3 000",
    "2018 года",
    "2026-11-20",
    "120 000 км",
  ]) expect(extractFields(text), text).toEqual({});
});

test("distances, times and sums are not read as a spaced-out plate", () => {
  expect(extractFields("в 150 км 30 минут")).toEqual({});
  expect(extractFields("с 100 тр 20")).toEqual({});
  expect(extractFields("а 123 вс 77")).toEqual({ plate: "А123ВС77" });
  expect(extractFields("А 123 ВС 77")).toEqual({ plate: "А123ВС77" });
  expect(extractFields("А123ВС777")).toEqual({ plate: "А123ВС777" });
});

test("a plate said in Latin letters is stored in Cyrillic, one plate one spelling", () => {
  expect(extractFields("A123BC77")).toEqual({ plate: "А123ВС77" });
});

test("the plate's digits never end up in the phone", () => {
  expect(extractFields("А123ВС77 89001234567")).toEqual({ plate: "А123ВС77", phone: "89001234567" });
});

test("a corrected name is the one kept, never the negation", () => {
  expect(extractFields("меня зовут не Анна а Мария")).toEqual({ name: "Мария" });
  expect(extractFields("меня зовут ну Олег")).toEqual({ name: "Олег" });
});

function run(start: ClientProfile = EMPTY_PROFILE) {
  const bus = new EventBus();
  let p = start;
  const sent: string[] = [];
  supervise({ bus, profile: () => p, setProfile: (n) => (p = n), send: (t) => sent.push(t) });
  const say = (text: string) => bus.emit({ type: "stt-result", result: { text, words: [] } });
  const endTurn = () => bus.emit({ type: "turn-end", at: 0, metrics: {} as never });
  return { say, endTurn, sent, profile: () => p };
}

test("what the customer says lands in the form without any tool call", () => {
  const s = run({ ...EMPTY_PROFILE, car: "Kia Rio" });
  s.say("меня зовут Анна, телефон 89001234567");
  expect(s.profile()).toMatchObject({ name: "Анна", phone: "89001234567", car: "Kia Rio" });
});

test("a returning customer is announced once, and each nudge is sent once", () => {
  const s = run({ ...EMPTY_PROFILE, name: "Анна" });
  expect(s.sent).toEqual(["Returning customer, already on file: name: Анна. Do not ask again."]);
  s.endTurn();
  s.endTurn();
  expect(s.sent.slice(1)).toEqual(["Form still missing: phone, car, service. Ask for one of them next."]);
  s.say("телефон 89001234567");
  s.endTurn();
  expect(s.sent.at(-1)).toBe("Form still missing: car, service. Ask for one of them next.");
});
