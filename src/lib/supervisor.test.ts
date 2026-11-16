import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventBus } from "./events";
import { EMPTY_PROFILE, type ClientProfile } from "./formModel";
import { extractFields, nudge, supervise } from "./supervisor";

// The dates below are fixed; without a fixed clock they turn into past dates and are refused.
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-16T09:00:00") }));
afterEach(() => vi.useRealTimers());

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

test("the demo's \"Hi, I'm Anna\" gives the name, \"I'm looking\" does not", () => {
  expect(extractFields("Hi, I'm Anna, I drive a Kia Rio and I need an oil change.")).toEqual({ name: "Anna" });
  expect(extractFields("Im Oleg")).toEqual({ name: "Oleg" });
  expect(extractFields("I'm looking for an oil change")).toEqual({});
  expect(extractFields("Hi, I'm Not sure. I'm Calling about brakes")).toEqual({});
});

test("a corrected name is the one kept, never the negation", () => {
  expect(extractFields("меня зовут не Анна а Мария")).toEqual({ name: "Мария" });
  expect(extractFields("меня зовут ну Олег")).toEqual({ name: "Олег" });
});

function run(start: ClientProfile = EMPTY_PROFILE) {
  const bus = new EventBus();
  let p = start;
  const sent: string[] = [];
  const hungUp = { count: 0 };
  supervise({ bus, profile: () => p, setProfile: (n) => (p = n), send: (t) => sent.push(t), hangUp: () => (hungUp.count += 1) });
  const say = (text: string) => bus.emit({ type: "stt-result", result: { text, words: [] } });
  const endTurn = () => bus.emit({ type: "turn-end", at: 0, metrics: {} as never });
  const agent = (text: string) => bus.emit({ type: "agent-reply", text, at: 0 });
  const stream = (text: string) => text.split(/(?<= )/).forEach((token) => bus.emit({ type: "llm-token", token, at: 0 }));
  const heard = () => bus.emit({ type: "stage-start", stage: "capture", at: 0 });
  return { bus, say, agent, stream, endTurn, heard, hungUp, sent, profile: () => p };
}

test("what the customer says waits for the agent to repeat it and the customer to say yes", () => {
  const s = run({ ...EMPTY_PROFILE, car: "Kia Rio" });
  s.say("меня зовут Анна, телефон 89001234567");
  expect(s.profile()).toEqual({ ...EMPTY_PROFILE, car: "Kia Rio" });
  s.agent("Ваш телефон +7 900 123-45-67, правильно?");
  expect(s.profile().phone).toBe("");
  s.say("да");
  expect(s.profile()).toMatchObject({ name: "", phone: "89001234567" });
  s.agent("Спасибо, Анна. Всё так?");
  s.say("да");
  expect(s.profile().name).toBe("Анна");
});

test("a yes followed by a but about the value read back fills nothing", () => {
  for (const answer of ["Да, но машина не та", "Yes, but that is not my car"]) {
    const s = run();
    s.agent("Записываю машину: Kia Rio. Верно?");
    s.say(answer);
    expect(s.profile().car, answer).toBe("");
  }
  const s = run();
  s.agent("Записываю имя: Анна. Верно?");
  s.say("да, но телефон не тот");
  expect(s.profile().name).toBe("Анна");
});

test("a yes to a question that does not repeat the customer's words fills nothing", () => {
  const s = run();
  s.say("телефон 89001234567");
  s.agent("Хотите записаться на завтра?");
  s.say("да");
  s.agent("Ваш телефон 8 900 123 45 67, верно?");
  s.say("нет, другой");
  expect(s.profile()).toEqual(EMPTY_PROFILE);
});

test("the agent's own read-back wins over a repeated word in the same reply", () => {
  const s = run();
  s.say("меня зовут Анна");
  s.agent("Анна, записываю машину: Kia Rio. Верно?");
  s.say("да");
  expect(s.profile()).toMatchObject({ name: "", car: "Kia Rio" });
});

test("a returning customer is briefed by the prompt only, and each nudge is sent once", () => {
  const s = run({ ...EMPTY_PROFILE, name: "Анна" });
  expect(s.sent).toEqual([]);
  s.endTurn();
  s.endTurn();
  expect(s.sent).toEqual(["Form still missing: phone, car, service. Ask for one of them next."]);
  s.agent("Записываю телефон: 89001234567. Верно?");
  s.say("да");
  s.endTurn();
  expect(s.sent.at(-1)).toBe("Form still missing: car, service. Ask for one of them next.");
});

test("a booked date with its time is not questioned after the booking", () => {
  expect(nudge({ name: "Анна", phone: "89001234567", car: "Kia Rio", plate: "", service: "Замена масла", date: "2026-11-17 10:30" })).toBeNull();
  expect(nudge({ name: "Анна", phone: "89001234567", car: "Kia Rio", plate: "", service: "Замена масла", date: "2026-11-17 25:30" })).toMatch(/date/);
});

test("a read-back reaches the form only on the customer's yes", () => {
  const s = run({ ...EMPTY_PROFILE, car: "Kia Rio" });
  s.agent("Записываю машину: Hyundai Solaris. Верно?");
  expect(s.profile().car).toBe("Kia Rio");
  s.say("нет, это не так");
  expect(s.profile().car).toBe("Kia Rio");
  s.agent("Записываю телефон: +7 912 345 67 89. Верно?");
  s.say("да, верно");
  expect(s.profile().phone).toBe("+7 912 345 67 89");
  s.say("да");
  s.agent("Записываю машину: Hyundai Solaris. Верно?");
  s.say("ну я не знаю");
  expect(s.profile().car).toBe("Kia Rio");
});

test("a streamed read-back, whose final agent-reply the session drops, is still confirmed by a yes", () => {
  const s = run();
  s.stream("Записываю машину: Kia Rio. Верно?");
  s.say("да");
  expect(s.profile().car).toBe("Kia Rio");
});

test("a yes after two read-backs takes neither, and the agent is told to read one at a time", () => {
  const s = run();
  s.agent("Записываю имя: Анна. Верно? Записываю машину: Kia Rio. Верно?");
  s.say("да");
  expect(s.profile()).toMatchObject({ name: "", car: "" });
  expect(s.sent).toEqual(["Read back one value per turn and wait for the customer's answer."]);
});

test("a safety symptom gets a stop-driving hint, once", () => {
  const s = run();
  s.say("у меня тормоза не работают");
  s.say("тормоза не работают совсем");
  expect(s.sent).toEqual([expect.stringMatching(/brakes not working.*not to drive.*tow truck/)]);
});

test("claiming a booking with the form incomplete is called out", () => {
  const s = run({ ...EMPTY_PROFILE, name: "Анна" });
  s.agent("Отлично, вы записаны на завтра.");
  expect(s.sent).toEqual([expect.stringMatching(/^Nothing is booked yet/)]);
});

test("a filled-in form is not a booking: the claim stands only after book_appointment succeeded", () => {
  const filled = { name: "Анна", phone: "89001234567", car: "Kia Rio", plate: "", service: "Замена масла", date: "" };
  const s = run(filled);
  s.agent("You are booked for tomorrow.");
  expect(s.sent).toEqual([expect.stringMatching(/^Nothing is booked yet.*call book_appointment/)]);

  const done = run(filled);
  done.bus.emit({ type: "tool-result", name: "book_appointment", facts: ["2026-11-17", "10:30"] });
  done.agent("Вы записаны на 17 ноября.");
  expect(done.sent).toEqual([]);
});

test("a bare name answering the name question is held, the agent is told to read it back, and a yes fills it", () => {
  const s = run();
  s.agent("Здравствуйте, автосервис АвтоЛаб, администратор записи. Как к вам обращаться?");
  s.say("Сергей.");
  expect(s.sent).toEqual([expect.stringMatching(/name: Сергей.*Read it back next/)]);
  s.agent("Приятно познакомиться, Сергей. Всё верно?");
  s.say("да");
  expect(s.profile().name).toBe("Сергей");
});

test("a bare word is not a name unless the agent just asked for one", () => {
  const s = run();
  s.agent("Какая у вас машина?");
  s.say("Солярис");
  s.agent("Солярис, верно?");
  s.say("да");
  expect(s.profile().name).toBe("");
});

test("once the last detail is confirmed the agent is told the case is closed, once", () => {
  const s = run({ name: "Сергей", phone: "89001234567", car: "Kia Rio", plate: "", service: "Замена масла", date: "" });
  s.agent("Записываю дату: 17.11.2026 10:30. Верно?");
  expect(s.sent).toEqual([]);
  s.say("да");
  expect(s.sent).toEqual([expect.stringMatching(/booking is recorded.*say goodbye, and ask nothing more/)]);
  s.say("спасибо");
  expect(s.sent).toHaveLength(1);
});

test("a form with no date is not closed", () => {
  const s = run({ name: "Сергей", phone: "89001234567", car: "Kia Rio", plate: "", service: "Замена масла", date: "" });
  s.say("ага");
  expect(s.sent).toEqual([]);
});

test("the call is hung up once the goodbye after the closing hint has been heard, and only then", () => {
  const s = run({ name: "Сергей", phone: "89001234567", car: "Kia Rio", plate: "", service: "Замена масла", date: "" });
  s.agent("До свидания? Нет, сначала дата. Записываю дату: 17.11.2026 10:30. Верно?");
  s.heard();
  expect(s.hungUp.count).toBe(0);
  s.say("да");
  s.agent("Отлично, что-нибудь ещё?");
  s.heard();
  expect(s.hungUp.count).toBe(0);
  s.stream("Вы записаны на замену масла 17 ноября в 10:30. До свидания!");
  expect(s.hungUp.count).toBe(0);
  s.heard();
  expect(s.hungUp.count).toBe(1);
  s.heard();
  expect(s.hungUp.count).toBe(1);
  expect(s.sent.filter((t) => t.startsWith("Nothing is booked"))).toEqual([]);
});

test("a goodbye before the form is complete does not hang up", () => {
  const s = run();
  s.agent("Хорошо, до свидания.");
  s.heard();
  expect(s.hungUp.count).toBe(0);
});

test("a booking already on file when the call starts neither closes the case nor hangs up", () => {
  const s = run({ name: "Сергей", phone: "89001234567", car: "Kia Rio", plate: "", service: "Замена масла", date: "2026-11-17 10:30" });
  s.say("алло");
  s.agent("Вы записаны на замену масла 17 ноября. Оставляем? Всего доброго.");
  s.heard();
  expect(s.sent).toEqual([]);
  expect(s.hungUp.count).toBe(0);
});
