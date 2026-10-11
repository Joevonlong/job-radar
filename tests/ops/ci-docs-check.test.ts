// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkCiDocs, compareMirror, compareWithDoc, dependabotErrors, documentedIn, inventoryOf } from "../../scripts/check-ci-docs";

const WORKFLOW = `
name: CI
jobs:
  changes:
    runs-on: ubuntu-24.04
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4
      - name: Classify the change
        run: echo hi
  unit:
    needs: changes
    steps:
      - name: Unit tests
        run: pnpm test
`;

const DOC = [
  "# CI",
  "## Jobs",
  "### Job `changes`",
  "intro",
  "#### Check out the repository",
  "text",
  "#### Classify the change",
  "```md",
  "#### Not a step, inside a fence",
  "```",
  "### Job `unit`",
  "#### Unit tests",
  "## Dependabot",
  "`npm` and `github-actions`",
  "## Other",
  "#### Ignored: no job open",
].join("\n");

const DEPENDABOT = "version: 2\nupdates:\n  - package-ecosystem: npm\n  - package-ecosystem: github-actions\n";

describe("inventoryOf", () => {
  it("lists jobs and step names", () => {
    const { jobs, errors } = inventoryOf([{ file: "a.yml", text: WORKFLOW }]);
    expect(errors).toEqual([]);
    expect([...jobs]).toEqual([
      ["changes", ["Check out the repository", "Classify the change"]],
      ["unit", ["Unit tests"]],
    ]);
  });

  it("requires a name on every step and unique names within a job", () => {
    const text = "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - name: X\n        run: x\n      - name: X\n        run: y\n";
    const { errors } = inventoryOf([{ file: "w.yml", text }]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('job "a", step 1 has no `name:`');
    expect(errors[1]).toContain('two steps named "X"');
  });

  it("rejects a job id used by two workflows", () => {
    const text = "jobs:\n  a:\n    steps: []\n";
    const { errors } = inventoryOf([{ file: "one.yml", text }, { file: "two.yml", text }]);
    expect(errors[0]).toContain("two.yml");
    expect(errors[0]).toContain("one.yml");
  });
});

describe("documentedIn", () => {
  it("reads job and step headings, ignoring fences and headings outside a job", () => {
    const { jobs, dependabot } = documentedIn(DOC);
    expect([...jobs]).toEqual([
      ["changes", ["Check out the repository", "Classify the change"]],
      ["unit", ["Unit tests"]],
    ]);
    expect(dependabot).toContain("`npm`");
    expect(dependabot).not.toContain("Ignored");
  });
});

describe("compareWithDoc", () => {
  const actual = inventoryOf([{ file: "a.yml", text: WORKFLOW }]).jobs;

  it("passes when the document matches", () => {
    expect(compareWithDoc("docs/ci.md", actual, documentedIn(DOC).jobs)).toEqual([]);
  });

  it("names the job to add", () => {
    const errors = compareWithDoc("docs/ci.md", actual, documentedIn(DOC.replace("### Job `unit`", "### Elsewhere")).jobs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('job "unit" is in the workflows but not documented');
    expect(errors[0]).toContain("### Job `unit`");
  });

  it("names the step to add", () => {
    const errors = compareWithDoc("docs/ci.md", actual, documentedIn(DOC.replace("#### Unit tests", "#### Other")).jobs);
    expect(errors.some((e) => e.includes('step "Unit tests" of job "unit" is not documented') && e.includes("#### Unit tests"))).toBe(true);
    expect(errors.some((e) => e.includes('documents step "Other"'))).toBe(true);
  });

  it("reports a documented job that no longer exists", () => {
    const errors = compareWithDoc("docs/ci.md", actual, documentedIn(`${DOC}\n### Job \`gone\`\n`).jobs);
    expect(errors).toEqual(['docs/ci.md: documents job "gone", but no workflow defines it. Remove or rename the "### Job `gone`" section.']);
  });
});

describe("compareMirror", () => {
  const en = documentedIn(DOC).jobs;

  it("passes for identical headings", () => {
    expect(compareMirror(en, documentedIn(DOC).jobs)).toEqual([]);
  });

  it("reports missing and extra jobs and steps", () => {
    const zh = documentedIn(DOC.replace("#### Classify the change", "#### Different").replace("### Job `unit`", "### Job `extra`")).jobs;
    const errors = compareMirror(en, zh);
    expect(errors.some((e) => e.includes('job "unit"') && e.includes("missing here"))).toBe(true);
    expect(errors.some((e) => e.includes('step "Classify the change"') && e.includes("missing here"))).toBe(true);
    expect(errors.some((e) => e.includes('has step "Different"'))).toBe(true);
    expect(errors.some((e) => e.includes('documents job "extra"'))).toBe(true);
  });
});

describe("dependabotErrors", () => {
  it("requires every ecosystem to be named in backticks", () => {
    expect(dependabotErrors(DEPENDABOT, "`npm` `github-actions`", "docs/ci.md")).toEqual([]);
    const errors = dependabotErrors(DEPENDABOT, "`npm`", "docs/ci.md");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("github-actions");
  });

  it("skips the check without a dependabot file", () => {
    expect(dependabotErrors(null, "", "docs/ci.md")).toEqual([]);
  });
});

describe("checkCiDocs (files on disk)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function repo(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-docs-"));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  }

  it("is clean when workflows, docs/ci.md and docs/ci.zh.md agree", () => {
    const root = repo({ ".github/workflows/ci.yml": WORKFLOW, ".github/dependabot.yml": DEPENDABOT, "docs/ci.md": DOC, "docs/ci.zh.md": DOC });
    expect(checkCiDocs(root)).toEqual([]);
  });

  it("fails when a step is added to the workflow without documenting it", () => {
    const changed = WORKFLOW.replace("      - name: Unit tests", "      - name: Brand new step\n        run: true\n      - name: Unit tests");
    const root = repo({ ".github/workflows/ci.yml": changed, "docs/ci.md": DOC, "docs/ci.zh.md": DOC });
    const errors = checkCiDocs(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"Brand new step"');
  });

  it("fails when the documents are missing", () => {
    const errors = checkCiDocs(repo({ ".github/workflows/ci.yml": WORKFLOW }));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("docs/ci.md is missing");
  });

  it("fails when the zh mirror drifts", () => {
    const root = repo({ ".github/workflows/ci.yml": WORKFLOW, "docs/ci.md": DOC, "docs/ci.zh.md": DOC.replace("### Job `unit`\n#### Unit tests\n", "") });
    const errors = checkCiDocs(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("docs/ci.zh.md");
  });
});

describe("the real repository", () => {
  it("has CI documentation that matches the workflows", () => {
    expect(checkCiDocs(path.resolve(import.meta.dirname, "../.."))).toEqual([]);
  });
});
