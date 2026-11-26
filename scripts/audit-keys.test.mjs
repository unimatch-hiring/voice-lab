import { describe, expect, it } from "vitest";
import { auditLines, concerns } from "./audit-keys.mjs";

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

const key = (over = {}) => ({
  id: "abc",
  hint: "vibe_1a2b…9z8y",
  label: "Candidate A",
  engine: "elevenlabs",
  issuedAt: NOW - HOUR,
  expiresAt: NOW + 3 * HOUR,
  budgetUsd: 5,
  spentUsd: 0.42,
  ...over,
});

describe("key audit", () => {
  it("prints the hint, label, time left and spend for each key", () => {
    const [, row] = auditLines([key()], NOW);
    expect(row).toMatch(/vibe_1a2b…9z8y\s+Candidate A\s+3h 00m\s+\$0\.42 \/ \$5\.00/);
  });

  it("never prints anything the admin API did not hand it as a hint", () => {
    const lines = auditLines([key({ token: "vibe_fullsecretvalue" })], NOW).join("\n");
    expect(lines).not.toContain("fullsecretvalue");
  });

  it("flags an unlabelled key, a long one and one near its budget", () => {
    const flagged = concerns(key({ label: "", expiresAt: NOW + 23 * HOUR, spentUsd: 4.5 }), NOW);
    expect(flagged).toEqual(["no label", "issued for over 8h", "near LLM budget"]);
  });

  it("says so when there is nothing live", () => {
    expect(auditLines([], NOW)).toEqual(["no live keys"]);
  });
});
