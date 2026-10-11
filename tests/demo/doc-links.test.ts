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
