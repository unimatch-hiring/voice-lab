import { describe, expect, it, test } from "vitest";
import { applyPatch, briefing, EMPTY_PROFILE, formText, parseProfile, missingRequired, validate, type ClientProfile } from "./formModel";

const ok: ClientProfile = {
  name: "Иван", phone: "+7 (916) 123-45-67", car: "Lada Vesta", plate: "А123ВС77", service: "ТО", date: "2026-03-14",
};

describe("validate", () => {
  test("a complete profile has no errors in either language", () => {
    expect(validate(ok, "ru")).toEqual({});
    expect(validate(ok, "en")).toEqual({});
  });

  test("optional fields may stay empty", () => {
    expect(validate({ ...ok, plate: "", date: "" }, "en")).toEqual({});
  });

  test("missing required fields are reported in the requested language", () => {
    const ru = validate(EMPTY_PROFILE, "ru");
    const en = validate(EMPTY_PROFILE, "en");
    expect(Object.keys(ru).sort()).toEqual(["car", "name", "phone", "service"]);
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
    expect(ru.name).toMatch(/[а-я]/i);
    expect(en.name).not.toMatch(/[а-я]/i);
  });

  test("phone punctuation is ignored, digit count is not", () => {
    expect(validate({ ...ok, phone: "8 916 123-45-67" }, "en").phone).toBeUndefined();
    expect(validate({ ...ok, phone: "12345" }, "en").phone).toBeTruthy();
    expect(validate({ ...ok, phone: "1234567890123456" }, "en").phone).toBeTruthy();
    expect(validate({ ...ok, phone: "916-abc-4567" }, "en").phone).toBeTruthy();
  });

  test("plate accepts Cyrillic and Latin, rejects length and symbols", () => {
    expect(validate({ ...ok, plate: "а123вс77" }, "en").plate).toBeUndefined();
    expect(validate({ ...ok, plate: "AB123CD" }, "en").plate).toBeUndefined();
    expect(validate({ ...ok, plate: "A12" }, "en").plate).toBeTruthy();
    expect(validate({ ...ok, plate: "A123BC77XYZ" }, "en").plate).toBeTruthy();
    expect(validate({ ...ok, plate: "A123-BC" }, "en").plate).toBeTruthy();
  });

  test("date must be a real ISO calendar date", () => {
    expect(validate({ ...ok, date: "2024-02-29" }, "en").date).toBeUndefined();
    expect(validate({ ...ok, date: "2025-02-30" }, "en").date).toBeTruthy();
    expect(validate({ ...ok, date: "14.03.2026" }, "ru").date).toBeTruthy();
  });
});

describe("applyPatch", () => {
  test("merges and trims, leaving other fields alone", () => {
    expect(applyPatch(ok, { name: "  Пётр  ", car: "Kia" })).toEqual({ ...ok, name: "Пётр", car: "Kia" });
  });

  test("ignores unknown keys and non-string values", () => {
    const junk = { name: 42, phone: null, car: { x: 1 }, admin: "yes" } as never;
    const next = applyPatch(ok, junk);
    expect(next).toEqual(ok);
    expect(next).not.toHaveProperty("admin");
  });

  test("does not mutate the input", () => {
    const before = { ...ok };
    applyPatch(ok, { name: "Z" });
    expect(ok).toEqual(before);
  });

  test("a blank string clears a field", () => {
    expect(applyPatch(ok, { plate: "  " }).plate).toBe("");
  });
});

describe("missingRequired", () => {
  test("lists only unset required fields", () => {
    expect(missingRequired(EMPTY_PROFILE)).toEqual(["name", "phone", "car", "service"]);
    expect(missingRequired({ ...ok, phone: "", plate: "" })).toEqual(["phone"]);
    expect(missingRequired({ ...ok, name: "   " })).toEqual(["name"]);
    expect(missingRequired(ok)).toEqual([]);
  });
});

describe("parseProfile", () => {
  it("restores what was saved", () => {
    const saved = { ...EMPTY_PROFILE, name: "Анна", phone: "+7 900 123-45-67" };
    expect(parseProfile(JSON.stringify(saved))).toEqual(saved);
  });

  it("reads a missing, corrupted or foreign record as an empty form", () => {
    for (const raw of ["", "{oops", "null", "42", '{"name":7,"evil":"x"}']) {
      expect(parseProfile(raw)).toEqual(EMPTY_PROFILE);
    }
  });
});

test("the briefing names what is on file and is empty for a stranger", () => {
  expect(briefing(EMPTY_PROFILE)).toBe("");
  const b = briefing({ ...EMPTY_PROFILE, name: "Анна", car: "Kia Rio" });
  expect(b).toContain("name: Анна");
  expect(b).toContain("car: Kia Rio");
  expect(b).not.toContain("phone");
});

test("the form as text keeps every field in order, the empty ones too", () => {
  expect(formText({ ...EMPTY_PROFILE, name: "Анна", car: "Kia Rio" }, "en")).toBe(
    "Name: Анна\nPhone: \nCar: Kia Rio\nPlate number: \nService: \nVisit date: \n",
  );
});
