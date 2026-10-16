// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("./coach/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, "utf8"));
const read = (file) => readFileSync(`${dir}${file}`, "utf8");

describe("the coach knowledge base", () => {
  it("lists every document it ships, and ships every document it lists", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    expect(manifest.documents.map((d) => d.file).sort()).toEqual(files);
  });

  it("traces every document to a dated source, and says whether its text may be copied", () => {
    for (const doc of manifest.documents) {
      expect(doc.title, doc.file).toBeTruthy();
      expect(doc.sources.length, doc.file).toBeGreaterThan(0);
      for (const src of doc.sources) {
        expect(src.url, doc.file).toMatch(/^https?:\/\//);
        expect(src.accessed, doc.file).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(["cc0", "paraphrase"], doc.file).toContain(src.reuse);
      }
      expect(read(doc.file), `${doc.file} names its source in the text the agent reads`).toMatch(
        /^# .+\n\nИсточники?: /,
      );
    }
  });
});
