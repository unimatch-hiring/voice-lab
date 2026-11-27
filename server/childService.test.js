// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChildService, EMPTY_DOC, ValidationError } from "./childService.js";
import { createJsonStore } from "./jsonStore.js";

let dir;
let file;
const classifier = { classify: vi.fn() };
const serviceOn = (path) => createChildService(createJsonStore(path, EMPTY_DOC), classifier);

beforeEach(async () => {
  classifier.classify.mockReset();
  dir = await mkdtemp(join(tmpdir(), "parental-"));
  file = join(dir, "db.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const SETTINGS = {
  allowedTopics: "space, dinosaurs",
  blockedTopics: "horror films",
  childProfile: "Masha, 7, loves drawing",
  triggerWords: "secret",
};

describe("parent settings", () => {
  it("starts empty before the parent has saved anything", async () => {
    expect(await serviceOn(file).getSettings()).toEqual(EMPTY_DOC.settings);
  });

  it("survives a server restart", async () => {
    await serviceOn(file).saveSettings(SETTINGS);

    expect(await serviceOn(file).getSettings()).toEqual(SETTINGS);
  });

  it("refuses a field that is not text", async () => {
    await expect(serviceOn(file).saveSettings({ ...SETTINGS, childProfile: 7 })).rejects.toThrow(
      ValidationError,
    );
  });

  it("keeps every save when two arrive at once", async () => {
    const service = serviceOn(file);
    await Promise.all([
      service.saveSettings({ ...SETTINGS, childProfile: "first" }),
      service.saveSettings({ ...SETTINGS, childProfile: "second" }),
    ]);

    expect((await serviceOn(file).getSettings()).childProfile).toBe("second");
  });
});

const CANDIDATE = {
  text: "Мне страшно идти домой, папа меня бьёт",
  context: [{ role: "assistant", text: "Что ты будешь делать после школы?" }],
  agentReply: "Мне очень жаль. Ты сейчас в безопасности?",
};
const CONCERN = { concern: true, category: "abuse", severity: "high", reason: "Говорит о побоях." };

describe("conversation log", () => {
  it("keeps every line in order across a restart", async () => {
    await serviceOn(file).appendTranscript({ role: "child", text: "Мне холодно" });
    await serviceOn(file).appendTranscript({ role: "assistant", text: "Укройся пледом" });

    expect((await serviceOn(file).listTranscript()).map((l) => [l.role, l.text])).toEqual([
      ["child", "Мне холодно"],
      ["assistant", "Укройся пледом"],
    ]);
  });
});

describe("alarm flags", () => {
  it("keeps a confirmed concern with the child's full message and the context", async () => {
    classifier.classify.mockResolvedValue(CONCERN);

    expect((await serviceOn(file).reviewFlag(CANDIDATE)).flagged).toBe(true);

    const [flag] = await serviceOn(file).listFlags();
    const { concern, ...review } = CONCERN;
    expect(flag).toEqual({ ...CANDIDATE, ...review, status: "confirmed", id: flag.id, at: flag.at });
    expect(flag.id).toBeTruthy();
  });

  it("does not store a match the review found harmless", async () => {
    classifier.classify.mockResolvedValue({ ...CONCERN, concern: false, category: "none" });

    expect(await serviceOn(file).reviewFlag(CANDIDATE)).toEqual({ flagged: false });
    expect(await serviceOn(file).listFlags()).toEqual([]);
  });

  it("keeps the flag as unverified when the review is unavailable", async () => {
    classifier.classify.mockRejectedValue(new Error("OpenAI answered 503"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await serviceOn(file).reviewFlag(CANDIDATE);

    const [flag] = await serviceOn(file).listFlags();
    expect(flag).toMatchObject({ text: CANDIDATE.text, status: "unverified" });
  });

  it("lists the newest flag first", async () => {
    classifier.classify.mockResolvedValue(CONCERN);
    const service = serviceOn(file);
    await service.reviewFlag({ ...CANDIDATE, text: "first" });
    await service.reviewFlag({ ...CANDIDATE, text: "second" });

    expect((await service.listFlags()).map((f) => f.text)).toEqual(["second", "first"]);
  });

  it("deleting the child's data clears flags and profile but keeps the parent's rules", async () => {
    classifier.classify.mockResolvedValue(CONCERN);
    const service = serviceOn(file);
    await service.saveSettings(SETTINGS);
    await service.reviewFlag(CANDIDATE);
    await service.appendTranscript({ role: "child", text: "Привет" });

    await service.deleteChildData();

    const fresh = serviceOn(file);
    expect(await fresh.listFlags()).toEqual([]);
    expect(await fresh.listTranscript()).toEqual([]);
    expect(await fresh.getSettings()).toEqual({ ...SETTINGS, childProfile: "" });
  });

  it("hands the parent's concerns to the review", async () => {
    classifier.classify.mockResolvedValue({ ...CONCERN, concern: false });
    const service = serviceOn(file);
    await service.saveSettings({ ...SETTINGS, triggerWords: "дядя Вася" });

    await service.reviewFlag(CANDIDATE);

    expect(classifier.classify).toHaveBeenCalledWith({ ...CANDIDATE, parentConcerns: "дядя Вася" });
  });

  it("keeps every flag when two reviews finish at once", async () => {
    classifier.classify.mockResolvedValue(CONCERN);
    const service = serviceOn(file);

    await Promise.all([
      service.reviewFlag({ ...CANDIDATE, text: "first" }),
      service.reviewFlag({ ...CANDIDATE, text: "second" }),
    ]);

    expect((await service.listFlags()).map((f) => f.text).sort()).toEqual(["first", "second"]);
  });

  it("stores nothing but the review's verdict, without internal fields", async () => {
    classifier.classify.mockResolvedValue(CONCERN);

    const { flag } = await serviceOn(file).reviewFlag(CANDIDATE);

    expect(flag).not.toHaveProperty("concern");
    expect(flag).not.toHaveProperty("parentConcerns");
  });

  it.each([
    ["too many context lines", { context: Array(4).fill({ role: "child", text: "x" }) }],
    ["a context line with an unknown role", { context: [{ role: "parent", text: "x" }] }],
    ["an empty agent reply", { agentReply: "" }],
  ])("refuses %s without reviewing it", async (_, patch) => {
    await expect(serviceOn(file).reviewFlag({ ...CANDIDATE, ...patch })).rejects.toThrow(
      ValidationError,
    );
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("refuses a candidate without the child's message", async () => {
    await expect(serviceOn(file).reviewFlag({ ...CANDIDATE, text: "" })).rejects.toThrow(
      ValidationError,
    );
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
