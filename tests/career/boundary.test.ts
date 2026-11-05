// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENGINE = "src/lib/career/engine";
const CAREER = ["src/lib/career", "src/components/career", "src/app/career", "src/app/api/career", "src/career-pdf"];
const PACKAGES = new Set(["yaml", "zod", "unpdf"]);
const config: unknown = await import(pathToFileURL(path.join(ROOT, "eslint.config.mjs")).href);
const { CORE_IMPORTING_CAREER } = z.object({ CORE_IMPORTING_CAREER: z.record(z.string(), z.array(z.string())) }).parse(config);
const options = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config, ts.sys, ROOT).options;
const cache = ts.createModuleResolutionCache(ROOT, (file) => file, options);
const eslint = new ESLint({ cwd: ROOT });

interface Dependency {
  source: string;
  kind: "static" | "dynamic" | "require";
}

function within(file: string, directory: string): boolean {
  return file === directory || file.startsWith(`${directory}/`);
}

function isCareer(file: string): boolean {
  return CAREER.some((directory) => within(file, directory));
}

function dependencies(source: ts.SourceFile): Dependency[] {
  const out: Dependency[] = [];
  function add(expression: ts.Node | undefined, kind: Dependency["kind"]) {
    if (expression && ts.isStringLiteralLike(expression)) out.push({ source: expression.text, kind });
    else out.push({ source: "<computed>", kind });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) add(node.moduleSpecifier, "static");
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, "require");
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, "static");
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], "dynamic");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") add(node.arguments[0], "require");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

function target(file: string, specifier: string): string | undefined {
  const resolved = ts.resolveModuleName(specifier, path.join(ROOT, file), options, ts.sys, cache).resolvedModule?.resolvedFileName;
  if (resolved && !resolved.includes("/node_modules/")) return path.relative(ROOT, resolved).replaceAll(path.sep, "/");
  if (specifier.startsWith("@/")) return path.posix.normalize(`src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return undefined;
}

function sourceFile(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(?:mjs|js)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

type CoreImports = Record<string, string[]>;

function coreCareerImports(sources: { file: string; text: string }[]): CoreImports {
  const actual: CoreImports = {};
  for (const { file, text } of sources) {
    if (isCareer(file)) continue;
    const targets = dependencies(sourceFile(file, text))
      .map((dependency) => target(file, dependency.source))
      .filter((to): to is string => to !== undefined && isCareer(to));
    if (targets.length) actual[file] = [...new Set(targets)].sort();
  }
  return actual;
}

function assertCoreImports(actual: CoreImports, expected: CoreImports): void {
  expect(actual).toEqual(expected);
}

function violations(file: string, text: string): string[] {
  const source = sourceFile(file, text);
  const out: string[] = [];
  for (const dependency of dependencies(source)) {
    const to = target(file, dependency.source);
    if (within(file, ENGINE)) {
      if (dependency.kind !== "static" || (!PACKAGES.has(dependency.source) && !(to && within(to, ENGINE) && !/\.(?:ts|tsx|js|mjs)$/.test(dependency.source)))) out.push(`${file}: impure ${dependency.kind} ${dependency.source}`);
    }
    if (!isCareer(file) && to && isCareer(to) && !CORE_IMPORTING_CAREER[file]?.includes(to)) out.push(`${file}: core imports ${to}`);
    if (to && within(to, "src/lib/career/print") && !within(file, "src/career-pdf") && !within(file, "src/lib/career/print")) out.push(`${file}: imports printing outside the PDF entry point`);
  }
  function visit(node: ts.Node) {
    if (within(file, ENGINE) && (ts.isMetaProperty(node) || (ts.isIdentifier(node) && ["Buffer", "process", "__dirname", "require"].includes(node.text)))) out.push(`${file}: runtime dependency ${node.getText(source)}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

function importForms(specifier: string): string[] {
  return [
    `import { value } from "${specifier}";`,
    `import type { Value } from "${specifier}";`,
    `import { type Value } from "${specifier}";`,
    `export { value } from "${specifier}";`,
    `export type { Value } from "${specifier}";`,
    `export const load = () => import("${specifier}");`,
    `const value = require("${specifier}");`,
    `import value = require("${specifier}");`,
    `type Value = import("${specifier}").Value;`,
  ];
}

async function restricted(file: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  expect(result?.fatalErrorCount, code).toBe(0);
  return (result?.messages ?? []).filter((message) => message.ruleId && ["@typescript-eslint/no-restricted-imports", "no-restricted-syntax", "no-restricted-globals"].includes(message.ruleId)).length;
}

test("all source dependencies respect the career and engine boundaries", () => {
  const sources = sourceFiles(path.join(ROOT, "src")).map((full) => ({ file: path.relative(ROOT, full).replaceAll(path.sep, "/"), text: fs.readFileSync(full, "utf8") }));
  const problems = sources.flatMap(({ file, text }) => violations(file, text));
  expect(problems).toEqual([]);
  assertCoreImports(coreCareerImports(sources), CORE_IMPORTING_CAREER);
});

test("the core career import whitelist stays empty", () => {
  expect(CORE_IMPORTING_CAREER).toEqual({});
});

test("core career import comparison rejects unlisted imports and unused whitelist entries", () => {
  const file = "src/lib/core/probe.ts";
  const to = `${ENGINE}/render.ts`;
  const actual = coreCareerImports([{ file, text: 'import "@/lib/career/engine/render";' }]);
  assertCoreImports(actual, { [file]: [to] });
  expect(() => assertCoreImports(actual, {})).toThrow();
  expect(() => assertCoreImports(coreCareerImports([{ file, text: "export {};" }]), { [file]: [to] })).toThrow();
});

test("the source walk covers TypeScript and JavaScript module extensions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "career-boundary-"));
  try {
    fs.mkdirSync(path.join(directory, "nested"));
    const files = ["probe.ts", "probe.tsx", "probe.mts", "probe.mjs", "probe.js"];
    for (const file of [...files, "probe.json"]) fs.writeFileSync(path.join(directory, "nested", file), 'import "@/lib/career/engine/render";');
    const sources = sourceFiles(directory);
    expect(sources.map((file) => path.basename(file)).sort()).toEqual(files.sort());
    for (const full of sources) {
      const file = `src/lib/core/${path.basename(full)}`;
      const text = fs.readFileSync(full, "utf8");
      expect(sourceFile(file, text).languageVariant).toBe(file.endsWith(".tsx") || /\.(?:mjs|js)$/.test(file) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard);
      expect(violations(file, text)).not.toEqual([]);
      assertCoreImports(coreCareerImports([{ file, text }]), { [file]: [`${ENGINE}/render.ts`] });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("boundary scanner negative controls", () => {
  test.each(["@/lib/career/engine", "@/components/career/Card", "@/app/career/page", "@/app/api/career/route", "@/career-pdf/main", "../career/store", "../../career/store"])("core cannot import %s by any syntax", (specifier) => {
    const file = specifier.startsWith("../../") ? "src/lib/deep/nested/file.ts" : "src/lib/core/file.ts";
    for (const code of importForms(specifier)) expect(violations(file, code), code).not.toEqual([]);
  });

  test("module consumers and unrelated career-named schemas are allowed", () => {
    for (const code of importForms("@/lib/career/engine")) expect(violations("src/components/career/Card.tsx", code)).toEqual([]);
    for (const code of importForms("@/lib/config")) expect(violations("src/lib/career/store.ts", code)).toEqual([]);
    expect(violations("src/lib/config/schemas/index.ts", 'export * from "./career";')).toEqual([]);
  });

  test.each(["node:fs", "fs", "playwright-core", "@/lib/config", "@/lib/career/print/x", "../../config", "../print/x", "./render.ts", "other-package"])("engine cannot import %s", (specifier) => {
    for (const code of importForms(specifier)) expect(violations(`${ENGINE}/probe.ts`, code), code).not.toEqual([]);
  });

  test("engine allows its modules and the three packages, and refuses location or dynamic runtime access", () => {
    for (const specifier of ["./render", "./themes/minimal/template", "@/lib/career/engine/render", ...PACKAGES]) {
      for (const code of importForms(specifier).filter((_, i) => i < 5 || i === 8)) expect(violations(`${ENGINE}/probe.ts`, code)).toEqual([]);
    }
    for (const code of ['import("./render")', 'import(name)', 'import.meta.url', 'Buffer.from("x")', 'process.cwd()', '__dirname']) expect(violations(`${ENGINE}/probe.ts`, code), code).not.toEqual([]);
  });

  test("printing is confined to the PDF entry point", () => {
    expect(violations("src/lib/career/preview.ts", 'import "./print/print-pdf";')).not.toEqual([]);
    expect(violations("src/career-pdf/main.ts", 'import "@/lib/career/print/print-pdf";')).toEqual([]);
    expect(violations("src/lib/career/print/print-pdf.ts", 'import "./x";')).toEqual([]);
  });
});

describe("ESLint boundary negative controls", () => {
  test.each(["@/lib/career/engine", "@/components/career/Card", "@/app/career/page", "@/app/api/career/route", "@/career-pdf/main"])("core alias %s is restricted including type imports", async (specifier) => {
    for (const file of ["src/lib/core.ts", "src/lib/db/probe.ts"]) {
      for (const code of importForms(specifier).slice(0, 6)) expect(await restricted(file, code), code).toBeGreaterThan(0);
    }
  });

  test.each(["src/lib/career/store.ts", "src/components/career/Card.tsx", "src/app/career/page.tsx", "src/app/api/career/route.ts", "src/career-pdf/main.ts"])("module imports are allowed in %s without weakening database restrictions", async (file) => {
    expect(await restricted(file, 'export * from "@/lib/career/engine";')).toBe(0);
    for (const specifier of ["drizzle-orm", "drizzle-orm/pg-core", "postgres", "@/lib/db/readonly-psql"]) {
      for (const code of importForms(specifier).slice(0, 6)) expect(await restricted(file, code), code).toBeGreaterThan(0);
    }
  });

  test("engine purity also restricts type-only and dynamic dependencies", async () => {
    const file = `${ENGINE}/probe.ts`;
    for (const specifier of ["node:fs", "fs", "playwright-core", "@/lib/config", "drizzle-orm", "drizzle-orm/pg-core", "postgres", "@/lib/db/readonly-psql", "other-package"]) {
      for (const code of importForms(specifier).slice(0, 6)) expect(await restricted(file, code), code).toBeGreaterThan(0);
    }
    for (const code of ['import("./render")', 'import.meta.url', 'require("./render")', 'process.cwd()', 'Buffer.from("x")', '__dirname']) expect(await restricted(file, code), code).toBeGreaterThan(0);
    for (const specifier of ["./render", ...PACKAGES]) expect(await restricted(file, `export * from "${specifier}";`)).toBe(0);
  });

  test.each(["tests/career/probe.ts", "e2e/career-probe.spec.ts", "scripts/career-probe.ts"])("non-source consumers in %s are allowed", async (file) => {
    expect(await restricted(file, 'export * from "@/lib/career/engine";')).toBe(0);
  });
});
