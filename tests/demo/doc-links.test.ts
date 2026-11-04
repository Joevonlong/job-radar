import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/check-doc-links.mjs");

let dir = "";
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function run(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-links-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
}

describe("docs:check images", () => {
  it("passes when every image exists", () => {
    const result = run({
      "img/a.png": "x",
      "img/b.png": "x",
      "README.md": '<picture><source media="(prefers-color-scheme: dark)" srcset="img/b.png"><img alt="a" src="img/a.png"></picture>\n<img src="img/a.png" srcset="img/a.png 1x, img/b.png 2x">\n',
      "docs/page.html": '<img srcset="../img/a.png 480w, ../img/b.png 960w" src="../img/a.png">',
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    ["an img src in Markdown", { "README.md": '<img alt="x" src="img/missing.png">' }],
    ["a picture srcset in Markdown", { "README.md": '<picture><source srcset="img/missing-dark.png"><img src="img/a.png"></picture>', "img/a.png": "x" }],
    ["a second srcset candidate in Markdown", { "README.md": '<img src="img/a.png" srcset="img/a.png 1x, img/missing.png 2x">', "img/a.png": "x" }],
    ["a srcset in HTML", { "docs/page.html": '<img src="../img/a.png" srcset="../img/missing.png 2x">', "img/a.png": "x" }],
  ])("fails on a missing image: %s", (_name, files) => {
    const result = run(files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing");
  });
});

describe("docs:check references", () => {
  const LINE_COMMENT = "//";
  const BLOCK_COMMENT = "/*";

  it.each([
    ["a comment in source", { "src/a.ts": "// the default actor is in research/actors.md\nexport const a = 1;\n" }, "src/a.ts:1: research/actors.md"],
    ["a block comment in source", { "src/a.css": "/*\n * Values from docs/design/tokens.css.\n */\n" }, "src/a.css:2: docs/design/tokens.css"],
    ["a string in source", { "src/a.ts": 'export const help = "see spec/guides/x.md";\n' }, "src/a.ts:1: spec/guides/x.md"],
    ["a YAML comment", { "config/a.yaml": "enabled: false # see dev-notes/notes.md\n" }, "config/a.yaml:1: dev-notes/notes.md"],
    ["a YAML comment in a fixture", { "tests/fixtures/a.yaml": "# plan: docs/plan.md\n" }, "tests/fixtures/a.yaml:1: docs/plan.md"],
    ["a comment in a test", { "tests/a.test.ts": "// from tracking/BUGS.md\n" }, "tests/a.test.ts:1: tracking/BUGS.md"],
    ["prose in Markdown", { "README.md": "Details are in `planning/roadmap.md`.\n" }, "README.md:1: planning/roadmap.md"],
    ["a bare Markdown name in a comment", { "src/a.ts": '// the rule of tokens.md "toast"\n' }, "src/a.ts:1: tokens.md"],
    ["a bare Markdown name after a Chinese bracket", { "src/a.ts": "// 规则（tokens.md）\n" }, "src/a.ts:1: tokens.md"],
    ["a JSX comment", { "src/a.tsx": `export const a = (\n  <p>\n    {${BLOCK_COMMENT} see research/actors.md */}\n  </p>\n);\n` }, "src/a.tsx:3: research/actors.md"],
    ["a trailing comment", { "src/a.ts": `export const a = 1; ${LINE_COMMENT} see spec/guides/x.md\n` }, "src/a.ts:1: spec/guides/x.md"],
    ["a path without an extension in a comment", { "src/a.ts": "// see spec/guides/x\n" }, "src/a.ts:1: spec/guides/x"],
    ["a workflow", { ".github/workflows/ci.yml": "# see tracking/BUGS.md\n" }, ".github/workflows/ci.yml:1: tracking/BUGS.md"],
    ["a comment in .env.example", { ".env.example": "# see dev-notes/env.md\nA=1\n" }, ".env.example:1: dev-notes/env.md"],
    ["a comment in a Dockerfile", { "Dockerfile": "# see promo/notes.md\nFROM x\n" }, "Dockerfile:1: promo/notes.md"],
    ["a comment under the sidecar's tests", { "jobspy/tests/test_a.py": "# see spec/a.md\n" }, "jobspy/tests/test_a.py:1: spec/a.md"],
  ])("fails on %s", (_name, files, expected) => {
    const result = run(files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  it("passes on paths that exist, other projects' paths, URLs and test data", () => {
    const result = run({
      "docs/mcp.md": "x",
      "docs/images/a.png": "x",
      "src/lib/research/001-format.ts": "x",
      "src/lib/index.ts": [
        'import { a } from "./research/001-format";',
        "// see docs/mcp.md, docs/mcp and docs/images/*.png",
        "// https://example.com/docs/missing.md and node_modules/next/dist/docs/missing.md",
        "// the skill's SKILL.md and mcp.md",
        "",
      ].join("\n"),
      ".github/workflows/ci.yml": "paths: ['docs/**', 'docs/*.zh.md']\n",
      "tests/a.test.ts": 'it("is data", () => write("docs/missing.md", "research/missing.md"));\n',
      "tests/fixtures/page.html": '<a href="docs/missing.html">x</a>\n',
      "tests/fixtures/data.json": '{ "path": "docs/missing.md" }\n',
      "jobspy/tests/test_a.py": 'path = "docs/missing.md"\n',
      "src/lib/words.ts": 'export const words = "research/development and marketing/sales";\n',
      "docs/words.md": "Roles in research/development.\n",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("reads what git tracks and does not ignore, and skips broken and looping symlinks", () => {
    const files = { ".gitignore": "local/\n", "local/notes.ts": "// docs/missing.md\n", "src/a.ts": "export const a = 1;\n" };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-links-"));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    fs.symlinkSync(path.join(dir, "gone.ts"), path.join(dir, "src/link.ts"));
    fs.symlinkSync(path.join(dir, "gone.md"), path.join(dir, "link.md"));
    fs.symlinkSync("loop.ts", path.join(dir, "src/loop.ts"));
    expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
    const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("does not look into hidden or generated directories", () => {
    const result = run({ ".next/a.js": 'const a = "docs/missing.md";\n', "drizzle/a.ts": "// docs/missing.md\n" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("README and features pictures", () => {
  const images = (file: string, prefix: string) =>
    [...fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(new RegExp(`(?:src|srcset)="(${prefix}images/[^"\\s]+)"`, "g"))].map((m) =>
      path.join(path.dirname(file), m[1] ?? ""),
    );

  it("exist, and the README shows the demo clips from the repository", () => {
    const en = images("README.md", "docs/");
    const zh = images("README.zh.md", "docs/");
    for (const image of [...en, ...zh]) expect(fs.existsSync(path.join(ROOT, image)), image).toBe(true);
    expect(en).toEqual(expect.arrayContaining(["docs/images/demo/overview.webp"]));
    expect(zh).toEqual(expect.arrayContaining(["docs/images/demo/overview.webp"]));
  });

  it("exist in the features page, and the Chinese one uses the Chinese screenshots", () => {
    const en = images("docs/features.md", "");
    const zh = images("docs/features.zh.md", "");
    expect(en.length).toBeGreaterThan(5);
    for (const image of [...en, ...zh]) expect(fs.existsSync(path.join(ROOT, image)), image).toBe(true);
    expect(zh).toEqual(expect.arrayContaining(["docs/images/today-zh.png", "docs/images/job-detail-zh.png"]));
    expect(zh).not.toContain("docs/images/today-light.png");
    expect(en).toEqual(expect.arrayContaining(["docs/images/today-light.png", "docs/images/today-dark.png", "docs/images/job-radar-demo.gif"]));
  });

  it("keeps the demo clips small enough for GitHub", () => {
    const dir = path.join(ROOT, "docs/images/demo");
    for (const name of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, name)).size, name).toBeLessThan(3.5 * 1024 * 1024);
  });
});
