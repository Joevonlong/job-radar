// @vitest-environment node
/**
 * Anti-regression: user-visible text lives in messages/*.json, never in code. This scans every string literal,
 * template part and JSX text of src/ and scripts/ (TypeScript AST, comments do not count) for Han characters, the
 * telltale of hard-coded Chinese copy. English copy is caught by review and the doctor / Telegram tests; Chinese is the
 * one that kept slipping in.
 */
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const HAN = /\p{Script=Han}/u;

/** Files that may hold Han text, each with the reason. Keep it short: copy belongs in messages/. */
const ALLOWED: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "src/lib/db/seed.ts", reason: "demo data of the seeded dashboard (job titles, summaries a Chinese-speaking user would have)" },
  { path: "src/lib/db/seed-demo.ts", reason: "demo data of the README screenshots (the Chinese job summaries)" },
  { path: "scripts/e2e-runner.ts", reason: "demo data the e2e tests look for" },
  { path: "src/i18n/catalog.generated.ts", reason: "generated from messages/*.json (language names and format words)" },
  { path: "src/lib/config/migrations/", reason: "comment templates written into the user's own older config files; data for existing installs, not product copy" },
  { path: "src/lib/signals/defaults.ts", reason: "the bilingual labels { zh, en } of the default signal categories, written into the user's interests.yaml (user data)" },
  { path: "src/lib/docs-link.ts", reason: "GitHub heading slugs of docs/*.zh.md (URL fragments, not copy)" },
];

function isAllowed(relative: string): boolean {
  return ALLOWED.some((entry) => (entry.path.endsWith("/") ? relative.startsWith(entry.path) : relative === entry.path));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** `file:line: text` for every literal with Han characters in a source text. */
export function hanLiterals(fileName: string, text: string): string[] {
  if (!HAN.test(text)) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let value: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) value = node.text;
    if (value !== null && HAN.test(value)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${fileName}:${line + 1}: ${value.trim().slice(0, 60)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("no hard-coded Chinese copy in code", () => {
  it("finds Han text in literals and JSX, not in comments or regular expressions", () => {
    const sample = ['// 注释不算', "const a = /[一-龥]/;", 'const b = "中文";', "const c = `x ${a} 模板`;", "const d = <p>文字</p>;"].join("\n");
    expect(hanLiterals("sample.tsx", sample).map((line) => line.split(": ")[1])).toEqual(["中文", "模板", "文字"]);
  });

  it("src/ and scripts/ have none outside the allow-list", () => {
    const offenders = ["src", "scripts"]
      .flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((relative) => !isAllowed(relative))
      .flatMap((relative) => hanLiterals(relative, fs.readFileSync(path.join(ROOT, relative), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every allow-list entry still exists (a stale entry would hide new files)", () => {
    for (const entry of ALLOWED) expect(fs.existsSync(path.join(ROOT, entry.path)), entry.path).toBe(true);
  });

  it("no hard-coded locale switches remain", () => {
    const code = ["src", "scripts"].flatMap((dir) => sourceFiles(path.join(ROOT, dir))).map((file) => fs.readFileSync(file, "utf8")).join("\n");
    expect(code).not.toMatch(/DEFAULT_LOCALE\s*=\s*"zh"/);
    expect(code).not.toMatch(/lang="zh-CN"/);
    expect(code).not.toMatch(/\bREASONS_LANGUAGE\b/);
    expect(code).not.toMatch(/\bTRANSLATION_LANG\b/);
  });
});
