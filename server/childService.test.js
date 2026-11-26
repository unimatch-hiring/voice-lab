// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChildService, EMPTY_DOC, ValidationError } from "./childService.js";
import { createJsonStore } from "./jsonStore.js";

let dir;
let file;
const serviceOn = (path) => createChildService(createJsonStore(path, EMPTY_DOC));

beforeEach(async () => {
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
