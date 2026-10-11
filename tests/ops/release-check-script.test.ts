// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** scripts/release-check.sh in a throw-away plain directory (no git, no Docker: --skip-gitleaks). */
const realScript = path.resolve(import.meta.dirname, "../../scripts/release-check.sh");

let dir = "";

/** An id of the private planning records, assembled here so this file itself holds none. */
const id = (prefix: string, digits: string): string => `${prefix}-${digits}`;

function write(rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function check(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync("bash", [path.join(dir, "scripts/release-check.sh"), "--skip-gitleaks", ...args], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_CHECK_PATTERNS_FILE: path.join(dir, "none") },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-check-"));
  write("scripts/release-check.sh", fs.readFileSync(realScript, "utf8"));
  write(".gitignore", ".env\n.env.local\ndata/\n.auth/\n");
  write("docs/guide.md", "Plain user text.\n");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("scripts/release-check.sh", () => {
  it("passes bash -n and pins the gitleaks image instead of using :latest", () => {
    expect(spawnSync("bash", ["-n", realScript]).status).toBe(0);
    const text = fs.readFileSync(realScript, "utf8");
    expect(text).not.toMatch(/gitleaks:latest/);
    expect(text).toMatch(/zricethezav\/gitleaks:v\d+\.\d+\.\d+/);
    expect(text).toContain("--log-opts");
  });

  it("is clean when no file names a planning id", () => {
    const r = check();
    expect(r.status).toBe(0);
    expect(r.out).toContain("no private planning ids");
  });

  it.each([
    ["docs/guide.md", `See ${id("F", "123")} for details.\n`],
    ["README.md", `Fixed in ${id("B", "045")}.\n`],
    ["config/x.yaml", `# ${id("ADR", "009")} says so\n`],
    ["messages/en.json", `{"a": "${id("F", "001")}"}\n`],
    ["src/a.ts", `// ${id("F", "123")} ${id("B", "045")} ${id("ADR", "009")}\n`],
    ["tests/a.test.ts", `it("${id("B", "045")}: x", () => {});\n`],
    ["src/b.ts", `// closed in ${id("M", "29")}\n`],
    ["scripts/x.sh", `# ${id("P", "18")}\n`],
  ])("fails on a planning id in %s", (file, content) => {
    write(file, content);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.out).toContain("private planning ids");
    expect(r.out).toContain(file);
  });

  it("ignores words that merely look similar", () => {
    write("docs/guide.md", "RFC-1234, ABC-123, F-12, UTF-8 and ISO-8859 are fine.\n");
    expect(check().status).toBe(0);
  });

  it("ignores B-tree, F-1, P-256, SHA-256 and utility class names", () => {
    write("docs/guide.md", "A B-tree index, F-1 and F-12, the P-256 curve, SHA-256, a p-12 class and m-10 are fine.\n");
    expect(check().status).toBe(0);
  });

  it("matches ADR in any case, and also reads file names", () => {
    write("docs/note.md", `see ${id("adr", "009")}\n`);
    const lower = check();
    expect(lower.status).toBe(1);
    expect(lower.out).toContain("docs/note.md");
    write("docs/note.md", "clean\n");
    write(`docs/${id("adr", "009")}-choice.md`, "clean\n");
    write(`tests/${id("B", "045")}/case.ts`, "clean\n");
    const named = check();
    expect(named.status).toBe(1);
    expect(named.out).toContain("choice.md");
    expect(named.out).toContain("(file name)");
    expect(named.out).toContain("case.ts");
  });

  it("does not scan drizzle/ or the lockfile at the root", () => {
    write("drizzle/0001_x.sql", `-- ${id("F", "123")}\n`);
    write("pnpm-lock.yaml", `${id("B", "045")}\n`);
    expect(check().status).toBe(0);
  });

  it("scans a drizzle folder or a lockfile name anywhere else", () => {
    write("src/drizzle/0001_x.sql", `-- ${id("F", "123")}\n`);
    write("docs/pnpm-lock.yaml", `${id("B", "045")}\n`);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/drizzle/0001_x.sql");
    expect(r.out).toContain("docs/pnpm-lock.yaml");
  });

  it("matches the allowlist by exact path or path:line, not by substring", () => {
    write("src/a.ts", `// ok\n// ${id("F", "123")}\n`);
    write("src/a.tsx", `// ${id("F", "123")}\n`);
    write("src/b.ts", `// ${id("F", "123")}\n`);
    write("scripts/planning-ids.allow", "src/a.ts:2\nsrc/b.ts\n");
    const r = check();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/a.tsx");
    expect(r.out).not.toContain("src/a.ts:");
    expect(r.out).not.toContain("src/b.ts");
    write("scripts/planning-ids.allow", "src/a.ts:3\nsrc/a.tsx\nsrc/b.ts\n");
    const wrongLine = check();
    expect(wrongLine.status).toBe(1);
    expect(wrongLine.out).toContain("src/a.ts:2");
  });

  it("lets a path of scripts/planning-ids.allow through, and only that path", () => {
    write("tests/fixtures/data.json", `{"a": "${id("F", "123")}"}\n`);
    write("src/a.ts", `// ${id("F", "123")}\n`);
    write("scripts/planning-ids.allow", "# why\ntests/fixtures/data.json   # an id that is data\n");
    const r = check();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/a.ts");
    expect(r.out).not.toContain("tests/fixtures/data.json");
    write("src/a.ts", "// clean\n");
    expect(check().status).toBe(0);
  });

  it("--planning-ids-only runs only that check", () => {
    write("src/a.ts", `// ${id("F", "123")}\n`);
    const bad = check("--planning-ids-only");
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("src/a.ts");
    expect(bad.out).not.toContain(".gitignore");
    write("src/a.ts", "// clean\n");
    const good = check("--planning-ids-only");
    expect(good.status).toBe(0);
    expect(good.out).toContain("no private planning ids");
  });

  it("finds no private planning ids anywhere in the real repository", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const r = spawnSync("bash", [realScript, "--skip-gitleaks"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RELEASE_CHECK_PATTERNS_FILE: "/nonexistent" },
    });
    expect(r.stdout).toContain("no private planning ids");
    expect(r.stdout).not.toContain("FAIL  private planning ids");
  });
});
