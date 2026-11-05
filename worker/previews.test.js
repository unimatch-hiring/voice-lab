import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A preview runs unreviewed code. Published anywhere the Worker trusts with /admin/, it would
// share IndexedDB with the admin page and could read the session out of it.
const root = process.cwd();
const toml = readFileSync(`${root}/worker/wrangler.toml`, "utf8");
const listed = (name) => toml.match(new RegExp(`^${name} = "(.*)"$`, "m"))[1].split(",");
const trusted = listed("ALLOWED_ORIGINS");
const previewOrigins = listed("PREVIEW_ORIGINS");

const dir = `${root}/.github/workflows`;
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .map((file) => ({ file, text: readFileSync(`${dir}/${file}`, "utf8") }));

const envValues = (name) =>
  workflows.flatMap(({ text }) => [...text.matchAll(new RegExp(`^\\s+${name}: (\\S+)$`, "gm"))].map((m) => m[1]));

/** The body of every `actions/checkout` step: the lines indented under its `- uses:`. */
function checkouts(text) {
  const lines = text.split("\n");
  const steps = [];
  lines.forEach((line, i) => {
    const head = line.match(/^(\s*)- uses: actions\/checkout@/);
    if (!head) return;
    const body = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() && next.search(/\S/) <= head[1].length) break;
      body.push(next);
    }
    steps.push(body.join("\n"));
  });
  return steps;
}

describe("where previews are published", () => {
  it("only the main deploy writes this repository's Pages branch", () => {
    const writers = workflows
      .filter(({ text }) =>
        checkouts(text).some((s) => /^\s+ref: gh-pages$/m.test(s) && !/^\s+repository:/m.test(s)),
      )
      .map(({ file }) => file);
    expect(writers).toEqual(["deploy.yml"]);
  });

  it("serves previews from an origin the Worker keeps away from /admin/", () => {
    const urls = envValues("PREVIEWS_URL");
    expect(urls.length).toBeGreaterThan(0);
    for (const origin of urls.map((u) => new URL(u).origin)) {
      expect(previewOrigins).toContain(origin);
      expect(trusted).not.toContain(origin);
    }
  });

  it("pushes previews to a repository whose Pages are that origin", () => {
    const repos = envValues("PREVIEWS_REPO");
    expect(repos.length).toBeGreaterThan(0);
    for (const origin of repos.map((r) => `https://${r.split("/")[0].toLowerCase()}.github.io`)) {
      expect(previewOrigins).toContain(origin);
      expect(trusted).not.toContain(origin);
    }
  });
});
