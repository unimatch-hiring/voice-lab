import { describe, expect, it } from "vitest";
import { buildChildPrompt } from "./childPrompt";
import { AGENT_ALARM_PHRASES } from "./triggers";
import { EMPTY_SETTINGS } from "./types";

describe("the child's prompt", () => {
  it("carries everything the parent wrote about the child and the topics", () => {
    const prompt = buildChildPrompt({
      allowedTopics: "space, dinosaurs",
      blockedTopics: "horror films",
      childProfile: "Masha, 7, loves drawing",
      triggerWords: "",
    });

    expect(prompt).toContain("Masha, 7, loves drawing");
    expect(prompt).toContain("space, dinosaurs");
    expect(prompt).toMatch(/must not discuss[^]*horror films/);
  });

  it("does not leave empty headings when the parent has written nothing", () => {
    const prompt = buildChildPrompt(EMPTY_SETTINGS);

    expect(prompt).toMatch(/child/);
    expect(prompt).not.toMatch(/must not discuss|from their parent/);
  });

  it("tells the agent the exact alarm phrase the page listens for", () => {
    expect(buildChildPrompt(EMPTY_SETTINGS)).toContain(AGENT_ALARM_PHRASES[0]);
    expect(buildChildPrompt(EMPTY_SETTINGS)).toContain(AGENT_ALARM_PHRASES[1]);
  });

  it("never leaks the alarm words into what the agent is told", () => {
    const prompt = buildChildPrompt({ ...EMPTY_SETTINGS, triggerWords: "secret-alarm-word" });

    expect(prompt).not.toContain("secret-alarm-word");
  });
});
