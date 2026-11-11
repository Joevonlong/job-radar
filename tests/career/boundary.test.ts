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
const PREPARE_ROUTES = ["src/app/api/career/extract/prepare/route.ts", "src/app/api/me/story-extract/prepare/route.ts"];
const PACKAGES = new Set(["yaml", "zod", "unpdf"]);
const CORE_ALIASES = [
  "@/lib/career/engine",
  "@/components/career/Card",
  "@/app/career/page",
  "@/app/api/career/route",
  "@/career-pdf/main",
];
const CORE_SPECIFIERS = [...CORE_ALIASES, "../career/store", "../../career/store"];
const CORE_FILES = ["src/lib/core.ts", "src/lib/db/probe.ts", "src/app/jobs/[id]/page.tsx"];
const MODULE_FILES = [
  "src/lib/career/store.ts",
  "src/components/career/Card.tsx",
  "src/app/career/page.tsx",
  "src/app/career/[id]/page.tsx",
  "src/app/api/career/route.ts",
  "src/career-pdf/main.ts",
];
const NON_SOURCE_FILES = ["tests/career/probe.ts", "e2e/career-probe.spec.ts", "scripts/career-probe.ts"];
const ENGINE_FORBIDDEN_SPECIFIERS = [
  "node:fs", "fs", "playwright-core", "@/lib/config", "@/lib/career/print/x", "../../config", "../print/x",
  "./render.ts", "other-package",
];
const DATABASE_SPECIFIERS = ["drizzle-orm", "drizzle-orm/pg-core", "postgres", "@/lib/db/readonly-psql"];
const ESLINT_ENGINE_FORBIDDEN_SPECIFIERS = [
  "node:fs", "fs", "playwright-core", "@/lib/config", ...DATABASE_SPECIFIERS, "other-package",
];
const COMPUTED_IMPORT_FILES = ["src/lib/core/file.ts", "src/lib/career/store.ts"];
const COMPUTED_IMPORTS = [
  { code: 'import(`@/lib/career/${x}`)', kind: "dynamic" },
  { code: 'import("@/lib/" + x)', kind: "dynamic" },
  { code: "require(name)", kind: "require" },
];
const PURITY_NEGATIVE_CASES = [
  'fetch("x")', "new XMLHttpRequest()", 'new WebSocket("x")', "__filename", "new Date()", "Date()",
  "Date.now()",
  "const now = Date.now",
  'Date["now"]()',
  "globalThis.Date.now()",
  "new globalThis.Date()",
  "const D = Date",
  "let D; D = Date",
  "const { now } = Date",
];
const config: unknown = await import(pathToFileURL(path.join(ROOT, "eslint.config.mjs")).href);
const { CORE_IMPORTING_CAREER, ENGINE_FORBIDDEN_GLOBALS, careerFiles } = z.object({
  CORE_IMPORTING_CAREER: z.record(z.string(), z.array(z.string())),
  ENGINE_FORBIDDEN_GLOBALS: z.array(z.string()),
  careerFiles: z.function({
    input: [z.record(z.string(), z.unknown())],
    output: z.array(z.string()),
  }),
}).parse(config);
const tsconfig = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, ROOT).options;
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

    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      add(node.moduleSpecifier, "static");
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, "require");
    }
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

const targetCache = new Map<string, string | undefined>();
function target(file: string, specifier: string): string | undefined {
  const key = `${file}:${specifier}`;
  if (targetCache.has(key)) return targetCache.get(key);
  const value = resolveTarget(file, specifier);
  targetCache.set(key, value);
  return value;
}

function resolveTarget(file: string, specifier: string): string | undefined {
  const resolved = ts.resolveModuleName(
    specifier, path.join(ROOT, file), options, ts.sys, cache,
  ).resolvedModule?.resolvedFileName;
  if (resolved && !resolved.includes("/node_modules/")) return path.relative(ROOT, resolved).replaceAll(path.sep, "/");
  if (specifier.startsWith("@/")) return path.posix.normalize(`src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return undefined;
}

const sourceCache = new Map<string, { text: string; source: ts.SourceFile }>();
function sourceFile(file: string, text: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached?.text === text) return cached.source;
  const isJavaScript = /\.(?:mjs|js)$/.test(file);
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : isJavaScript ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  sourceCache.set(file, { text, source });
  return source;
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
    if (!within(file, "src") || isCareer(file)) continue;
    const targets = dependencies(sourceFile(file, text))
      .map((dependency) => target(file, dependency.source))
      .filter((to): to is string => to !== undefined && isCareer(to));
    if (targets.length) actual[file] = [...new Set(targets)].sort();
  }
  return actual;
}

function violations(file: string, text: string): string[] {
  const source = sourceFile(file, text);
  const out: string[] = [];
  for (const dependency of dependencies(source)) {
    if (within(file, "src") && dependency.source === "<computed>") {
      out.push(`${file}: computed ${dependency.kind} import`);
      continue;
    }
    const to = target(file, dependency.source);
    if (within(file, ENGINE)) {
      const isStatic = dependency.kind === "static";
      const isAllowedPackage = PACKAGES.has(dependency.source);
      const isEngineModule = to !== undefined && within(to, ENGINE);
      const hasSourceExtension = /\.(?:ts|tsx|js|mjs)$/.test(dependency.source);
      const isAllowedModule = isEngineModule && !hasSourceExtension;
      if (!isStatic || (!isAllowedPackage && !isAllowedModule)) {
        out.push(`${file}: impure ${dependency.kind} ${dependency.source}`);
      }
    }
    if (within(file, "src") && !isCareer(file) && to && isCareer(to) && !CORE_IMPORTING_CAREER[file]?.includes(to)) {
      out.push(`${file}: core imports ${to}`);
    }
    const engineConsumer = [ENGINE, "src/lib/career/render", "src/lib/career/print", "src/lib/career/import", "src/app/career", "src/app/api/career"]
      .some((directory) => within(file, directory));
    if (within(file, "src") && to && within(to, ENGINE) && !engineConsumer) out.push(`${file}: imports engine outside rendering boundary`);
    const isStorage = ["schema", "store", "contact", "ai", "extract", "tailor", "document"].some((part) => within(file, `src/lib/career/${part}`));
    const importsRendering = to && (within(to, ENGINE) || within(to, "src/lib/career/print") || to.includes("/fonts/"));
    if (isStorage && (importsRendering || /@fontsource/.test(dependency.source))) {
      out.push(`${file}: storage imports rendering dependency`);
    }
    const isAi = ["ai", "extract", "tailor"].some((part) => within(file, `src/lib/career/${part}`));
    if (isAi && to === "src/lib/career/contact/store.ts") out.push(`${file}: reads contact storage directly`);
    if ((within(file, "src/lib/outbound") || within(file, "src/components/outbound")) && to && isCareer(to)) out.push(`${file}: outbound imports career`);
    if (["src/lib/outbound/scrub.ts", "src/lib/outbound/outbound.ts"].includes(file) && /^(?:node:)?fs(?:\/|$)/.test(dependency.source)) out.push(`${file}: pure outbound reads files`);
    const isPrintTarget = to !== undefined && within(to, "src/lib/career/print");
    const isPrintConsumer = within(file, "src/career-pdf") || within(file, "src/lib/career/print") || within(file, "tests") || within(file, "e2e") || within(file, "scripts");
    if (isPrintTarget && !isPrintConsumer) out.push(`${file}: imports printing outside the PDF entry point`);
  }
  function visit(node: ts.Node) {
    if (within(file, "src") && ts.isIdentifier(node)) {
      if (node.text === "prepareScrub" && !["src/lib/outbound/scrub.ts", "src/lib/career/contact/scrub.ts", ...PREPARE_ROUTES].includes(file)) out.push(`${file}: reads preview candidates outside prepare`);
      if (node.text === "prepareCareerScrub" && !["src/lib/career/contact/scrub.ts", ...PREPARE_ROUTES].includes(file)) out.push(`${file}: reads local candidates outside prepare`);
      if (node.text === "readPrepareInput" && !["src/lib/outbound/prepare.ts", ...PREPARE_ROUTES].includes(file)) out.push(`${file}: reads uploads outside prepare`);
    }
    if (isCareer(file) && ts.isIdentifier(node) && node.text === "NO_STORED_VALUES") out.push(`${file}: bypasses stored contact values`);
    const isRuntimeGlobal = ts.isIdentifier(node) && ENGINE_FORBIDDEN_GLOBALS.includes(node.text);
    if (within(file, ENGINE) && (ts.isMetaProperty(node) || isRuntimeGlobal)) {
      out.push(`${file}: runtime dependency ${node.getText(source)}`);
    }
    const memberObject = (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    const memberProperty = ts.isPropertyAccessExpression(node) ? node.name.text :
      ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
    const isAssignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    const dateAlias = (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === "Date") ||
      (isAssignment && ts.isIdentifier(node.right) && node.right.text === "Date");
    const clockRead = (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && !node.arguments?.length) ||
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") ||
      (memberObject === "Date" && memberProperty === "now") ||
      (memberObject === "globalThis" && memberProperty === "Date") || dateAlias;
    if (within(file, ENGINE) && clockRead) out.push(`${file}: clock read ${node.getText(source)}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

function importForms(specifier: string) {
  return {
    declarations: [
      `import { value } from "${specifier}";`,
      `import type { Value } from "${specifier}";`,
      `import { type Value } from "${specifier}";`,
      `export { value } from "${specifier}";`,
      `export type { Value } from "${specifier}";`,
    ],
    dynamicImport: [`export const load = () => import("${specifier}");`],
    requires: [
      `const value = require("${specifier}");`,
      `import value = require("${specifier}");`,
    ],
    importType: [`type Value = import("${specifier}").Value;`],
  };
}

function allImportForms(specifier: string): string[] {
  return Object.values(importForms(specifier)).flat();
}

function eslintImportForms(specifier: string): string[] {
  const { declarations, dynamicImport } = importForms(specifier);
  return [...declarations, ...dynamicImport];
}

function engineImportForms(specifier: string): string[] {
  const { declarations, importType } = importForms(specifier);
  return [...declarations, ...importType];
}

async function restricted(file: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  expect(result?.fatalErrorCount, code).toBe(0);
  const rules = ["@typescript-eslint/no-restricted-imports", "no-restricted-syntax", "no-restricted-globals"];
  return (result?.messages ?? []).filter((message) => message.ruleId && rules.includes(message.ruleId)).length;
}

test("all source dependencies respect the career and engine boundaries", () => {
  const sources = ["src", "scripts", "tests", "e2e"].flatMap((dir) => sourceFiles(path.join(ROOT, dir))).map((full) => ({
    file: path.relative(ROOT, full).replaceAll(path.sep, "/"),
    text: fs.readFileSync(full, "utf8"),
  }));
  const problems = sources.flatMap(({ file, text }) => violations(file, text));
  expect(problems).toEqual([]);
  expect(coreCareerImports(sources)).toEqual(CORE_IMPORTING_CAREER);
});

test("core career consumers are limited to UI entries, handlers and read capabilities with redacted DTOs", () => {
  expect(Object.keys(CORE_IMPORTING_CAREER).sort()).toEqual([
    "src/app/jobs/[id]/page.tsx",
    "src/app/me/page.tsx",
    "src/lib/capabilities/career/check-career-document.ts",
    "src/lib/capabilities/career/get-career-document.ts",
    "src/lib/capabilities/career/get-career-profile.ts",
    "src/lib/capabilities/career/list-career-documents.ts",
    "src/lib/capabilities/career/shared.ts",
    "src/lib/control/ai-handlers.ts",
    "src/lib/mcp/dto/career.ts",
  ]);
});

test("core career import comparison rejects unlisted imports and unused whitelist entries", () => {
  const file = "src/lib/core/probe.ts";
  const to = `${ENGINE}/render.ts`;
  const actual = coreCareerImports([{ file, text: 'import "@/lib/career/engine/render";' }]);
  expect(actual).toEqual({ [file]: [to] });
  expect(actual).not.toEqual({});
  expect(coreCareerImports([{ file, text: "export {};" }])).not.toEqual({ [file]: [to] });
});

test("the source walk covers TypeScript and JavaScript module extensions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "career-boundary-"));
  try {
    fs.mkdirSync(path.join(directory, "nested"));
    const files = ["probe.ts", "probe.tsx", "probe.mts", "probe.mjs", "probe.js"];
    for (const file of [...files, "probe.json"]) {
      fs.writeFileSync(path.join(directory, "nested", file), 'import "@/lib/career/engine/render";');
    }
    const sources = sourceFiles(directory);
    expect(sources.map((file) => path.basename(file)).sort()).toEqual(files.sort());
    for (const full of sources) {
      const file = `src/lib/core/${path.basename(full)}`;
      const text = fs.readFileSync(full, "utf8");
      const isJsx = file.endsWith(".tsx") || /\.(?:mjs|js)$/.test(file);
      const variant = isJsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
      expect(sourceFile(file, text).languageVariant).toBe(variant);
      expect(violations(file, text)).not.toEqual([]);
      expect(coreCareerImports([{ file, text }])).toEqual({ [file]: [`${ENGINE}/render.ts`] });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("boundary scanner negative controls", () => {
  test.each(CORE_SPECIFIERS)("core cannot import %s by any syntax", (specifier) => {
    const file = specifier.startsWith("../../") ? "src/lib/deep/nested/file.ts" : "src/lib/core/file.ts";
    for (const code of allImportForms(specifier)) expect(violations(file, code), code).not.toEqual([]);
  });

  test.each(COMPUTED_IMPORT_FILES)("computed imports are restricted in %s", (file) => {
    for (const { code, kind } of COMPUTED_IMPORTS) {
      expect(violations(file, code), code).toEqual([`${file}: computed ${kind} import`]);
    }
  });

  test("module consumers and unrelated career-named schemas are allowed", () => {
    for (const code of allImportForms("@/lib/career/engine")) {
      expect(violations("src/lib/career/render/probe.ts", code)).toEqual([]);
    }
    for (const code of allImportForms("@/lib/config")) {
      expect(violations("src/lib/career/store.ts", code)).toEqual([]);
    }
    expect(violations("src/lib/config/schemas/index.ts", 'export * from "./career";')).toEqual([]);
  });

  test.each(ENGINE_FORBIDDEN_SPECIFIERS)("engine cannot import %s", (specifier) => {
    for (const code of allImportForms(specifier)) expect(violations(`${ENGINE}/probe.ts`, code), code).not.toEqual([]);
  });

  test("engine allows its modules and the three packages, and refuses location or dynamic runtime access", () => {
    for (const specifier of ["./render", "./themes/minimal/template", "@/lib/career/engine/render", ...PACKAGES]) {
      for (const code of engineImportForms(specifier)) expect(violations(`${ENGINE}/probe.ts`, code)).toEqual([]);
    }
    const runtimeAccess = [
      'import("./render")', 'import(name)', 'import.meta.url', 'Buffer.from("x")', 'process.cwd()', '__dirname',
    ];
    for (const code of runtimeAccess) expect(violations(`${ENGINE}/probe.ts`, code), code).not.toEqual([]);
  });

  test.each(PURITY_NEGATIVE_CASES)("engine rejects runtime access through %s", (code) => {
    expect(violations(`${ENGINE}/probe.ts`, code), code).not.toEqual([]);
  });

  test("printing is confined to PDF entry points, tests, e2e and scripts", () => {
    for (const file of ["src/lib/core.ts", "src/lib/career/render/probe.ts", "src/app/career/page.tsx"]) {
      for (const code of allImportForms("@/lib/career/print/print-pdf")) expect(violations(file, code)).not.toEqual([]);
    }
    for (const file of ["e2e/career-print.spec.ts", "scripts/probe.ts", "tests/career/probe.ts"]) {
      for (const code of allImportForms("@/lib/career/print/print-pdf")) expect(violations(file, code)).toEqual([]);
    }
    expect(violations("src/lib/career/preview.ts", 'import "./print/print-pdf";')).not.toEqual([]);
    expect(violations("src/career-pdf/main.ts", 'import "@/lib/career/print/print-pdf";')).toEqual([]);
    expect(violations("src/lib/career/print/print-pdf.ts", 'import "./x";')).toEqual([]);
  });
});

describe("ESLint boundary negative controls", () => {
  test.each(CORE_ALIASES)("core alias %s is restricted including type imports", async (specifier) => {
    for (const file of CORE_FILES) {
      for (const code of eslintImportForms(specifier)) {
        expect(await restricted(file, code), code).toBeGreaterThan(0);
      }
    }
  });

  test.each(MODULE_FILES)("module imports are allowed in %s without weakening database restrictions", async (file) => {
    expect(await restricted(file, 'export * from "@/lib/career/schema/profile";')).toBe(0);
    for (const specifier of DATABASE_SPECIFIERS) {
      for (const code of eslintImportForms(specifier)) {
        expect(await restricted(file, code), code).toBeGreaterThan(0);
      }
    }
  });

  test("bracketed core file globs match literal brackets rather than a character class", async () => {
    const coreFile = "src/app/jobs/[id]/page.tsx";
    const plainFile = "src/app/jobs/i/page.tsx";
    const coreFiles = { [coreFile]: [] };
    const cases = [
      { files: careerFiles(coreFiles), expectedCounts: [1, 0] },
      { files: Object.keys(coreFiles), expectedCounts: [0, 1] },
    ];
    for (const { files, expectedCounts } of cases) {
      const isolated = new ESLint({
        cwd: ROOT,
        overrideConfigFile: true,
        overrideConfig: [
          { files: ["**/*.tsx"] },
          { files, rules: { "no-console": "error" } },
        ],
      });
      const counts: number[] = [];
      for (const filePath of [coreFile, plainFile]) {
        const [result] = await isolated.lintText('console.log("x");', { filePath });
        expect(result?.fatalErrorCount).toBe(0);
        counts.push((result?.messages ?? []).filter((message) => message.ruleId === "no-console").length);
      }
      expect(counts).toEqual(expectedCounts);
    }
  });

  test("engine purity also restricts type-only and dynamic dependencies", async () => {
    const file = `${ENGINE}/probe.ts`;
    for (const specifier of ESLINT_ENGINE_FORBIDDEN_SPECIFIERS) {
      for (const code of eslintImportForms(specifier)) {
        expect(await restricted(file, code), code).toBeGreaterThan(0);
      }
    }
    const runtimeAccess = [
      'import("./render")', 'import.meta.url', 'require("./render")', 'process.cwd()', 'Buffer.from("x")', '__dirname',
    ];
    for (const code of runtimeAccess) expect(await restricted(file, code), code).toBeGreaterThan(0);
    for (const specifier of ["./render", ...PACKAGES]) {
      expect(await restricted(file, `export * from "${specifier}";`)).toBe(0);
    }
  });

  test.each(PURITY_NEGATIVE_CASES)("engine runtime access through %s is restricted", async (code) => {
    expect(await restricted(`${ENGINE}/probe.ts`, code), code).toBeGreaterThan(0);
  });

  test.each(NON_SOURCE_FILES)("non-source consumers in %s are allowed", async (file) => {
    expect(await restricted(file, 'export * from "@/lib/career/engine";')).toBe(0);
  });
});

test("date parsing is allowed by both purity layers", async () => {
  const code = 'new Date("2026-01-01")';
  expect(violations(`${ENGINE}/probe.ts`, code)).toEqual([]);
  expect(await restricted(`${ENGINE}/probe.ts`, code)).toBe(0);
});

test("preview candidates and stored-value bypasses stay at their permitted boundaries", async () => {
  expect(violations("src/lib/career/ai/probe.ts", 'import { NO_STORED_VALUES } from "@/lib/outbound/outbound";')).not.toEqual([]);
  expect(violations("src/lib/career/ai/probe.ts", 'import { prepareCareerScrub } from "../contact/scrub";')).not.toEqual([]);
  expect(violations("src/lib/career/extract/probe.ts", 'import { prepareScrub } from "@/lib/outbound/scrub";')).not.toEqual([]);
  expect(violations(PREPARE_ROUTES[0]!, 'import { prepareCareerScrub } from "@/lib/career/contact/scrub";')).toEqual([]);
  for (const specifier of ["@/lib/career/contact/store", "../contact/store"]) {
    for (const code of allImportForms(specifier)) expect(violations("src/lib/career/ai/probe.ts", code)).not.toEqual([]);
    for (const code of eslintImportForms(specifier)) expect(await restricted("src/lib/career/ai/probe.ts", code)).toBeGreaterThan(0);
  }
});

test("storage dependencies reject rendering imports by every syntax and relative path", async () => {
  for (const directory of ["schema", "store", "contact", "ai", "extract", "tailor", "document"]) {
    const file = `src/lib/career/${directory}/probe.ts`;
    for (const specifier of [
      "@/lib/career/engine",
      "../engine",
      "@/lib/career/print/print-pdf",
      "../print/print-pdf",
      "@fontsource/archivo",
    ]) {
      for (const code of allImportForms(specifier)) expect(violations(file, code)).not.toEqual([]);
    }
    for (const specifier of ["@/lib/career/engine", "../engine/schema", "../print/print-pdf", "@fontsource/archivo", ...DATABASE_SPECIFIERS]) {
      for (const code of eslintImportForms(specifier)) expect(await restricted(file, code)).toBeGreaterThan(0);
    }
  }
});

test("the core profile page may import only the card and retains database restrictions", async () => {
  const file = "src/app/me/page.tsx";
  for (const code of allImportForms("@/components/career/career-card")) expect(violations(file, code)).toEqual([]);
  for (const specifier of ["@/lib/career/store/profile", "@/components/career/career-editor", ...DATABASE_SPECIFIERS]) {
    for (const code of importForms(specifier).declarations) expect(await restricted(file, code)).toBeGreaterThan(0);
  }
  expect(await restricted(file, 'import { CareerCard } from "@/components/career/career-card";')).toBe(0);
});


test("engine consumers and printer restrictions are enforced across rendering boundaries", async () => {
  for (const file of ["src/lib/career/document/probe.ts", "src/components/career/probe.tsx", "src/lib/career/preview.ts", "src/career-pdf/probe.ts"]) {
    for (const specifier of ["@/lib/career/engine/render", `./${path.posix.relative(path.posix.dirname(file), `${ENGINE}/render`)}`]) {
      for (const code of allImportForms(specifier)) expect(violations(file, code)).not.toEqual([]);
      for (const code of eslintImportForms(specifier)) expect(await restricted(file, code)).toBeGreaterThan(0);
    }
  }
  for (const file of ["src/lib/career/render/probe.ts", "src/lib/career/import/probe.ts", "src/app/career/page.tsx", "src/app/api/career/route.ts"]) {
    expect(violations(file, 'import "@/lib/career/engine/render";')).toEqual([]);
    expect(await restricted(file, 'import "@/lib/career/engine/render";')).toBe(0);
    for (const specifier of ["@/lib/career/print/print-pdf", `./${path.posix.relative(path.posix.dirname(file), "src/lib/career/print/print-pdf")}`]) {
      for (const code of allImportForms(specifier)) expect(violations(file, code)).not.toEqual([]);
      for (const code of eslintImportForms(specifier)) expect(await restricted(file, code)).toBeGreaterThan(0);
    }
    for (const specifier of DATABASE_SPECIFIERS) expect(await restricted(file, `import "${specifier}";`)).toBeGreaterThan(0);
  }
});


test("every app area rejects print imports without allowing core career or database imports", async () => {
  for (const file of ["src/app/jobs/page.tsx", "src/app/me/page.tsx", "src/app/api/jobs/route.ts"]) {
    const relative = `./${path.posix.relative(path.posix.dirname(file), "src/lib/career/print/print-pdf")}`;
    for (const specifier of ["@/lib/career/print/print-pdf", relative, ...DATABASE_SPECIFIERS]) {
      for (const code of eslintImportForms(specifier)) expect(await restricted(file, code), `${file}: ${code}`).toBeGreaterThan(0);
    }
    for (const specifier of ["@/lib/career/engine/render", `./${path.posix.relative(path.posix.dirname(file), `${ENGINE}/render`)}`]) {
      for (const code of eslintImportForms(specifier)) expect(await restricted(file, code)).toBeGreaterThan(0);
    }
  }
});


test("print modules may import the engine and retain database restrictions", async () => {
  const file = "src/lib/career/print/probe.ts";
  for (const specifier of ["@/lib/career/engine", "@/lib/career/engine/render", "../engine", "../engine/render"]) {
    for (const code of allImportForms(specifier)) expect(violations(file, code), code).toEqual([]);
    for (const code of eslintImportForms(specifier)) expect(await restricted(file, code), code).toBe(0);
  }
  for (const specifier of DATABASE_SPECIFIERS) {
    for (const code of eslintImportForms(specifier)) expect(await restricted(file, code), code).toBeGreaterThan(0);
  }
});

test("every whitelisted core file retains its permitted career imports", async () => {
  for (const [file, targets] of Object.entries(CORE_IMPORTING_CAREER)) {
    for (const target of targets) {
      const specifier = target.replace(/^src\//, "@/").replace(/\.tsx?$/, "");
      for (const code of eslintImportForms(specifier)) expect(await restricted(file, code), `${file}: ${code}`).toBe(0);
    }
    for (const specifier of DATABASE_SPECIFIERS) {
      for (const code of eslintImportForms(specifier)) expect(await restricted(file, code), `${file}: ${code}`).toBeGreaterThan(0);
    }
  }
});

function importedTargets(directory: string): { file: string; to: string }[] {
  if (!fs.existsSync(path.join(ROOT, directory))) return [];
  return sourceFiles(path.join(ROOT, directory)).flatMap((full) => {
    const file = path.relative(ROOT, full).replaceAll(path.sep, "/");
    const { importedFiles } = ts.preProcessFile(fs.readFileSync(full, "utf8"), true, true);
    return importedFiles.flatMap(({ fileName }) => {
      const to = target(file, fileName);
      return to ? [{ file, to }] : [];
    });
  });
}

test("the resume-kit import is reachable only from web routes and pages, never from AI, extraction, apply or the runner", () => {
  const forbidden = ["src/lib/career/ai", "src/lib/career/extract", "src/lib/career/apply", "src/lib/career/tailor", "src/runner"]
    .flatMap(importedTargets)
    .filter(({ to }) => to.startsWith("src/lib/career/import/"));
  expect(forbidden).toEqual([]);
  const users = ["src"].flatMap(importedTargets)
    .filter(({ file, to }) => to.startsWith("src/lib/career/import/") && !file.startsWith("src/lib/career/import/"))
    .map(({ file }) => file);
  expect([...new Set(users)].sort()).toEqual(["src/app/api/career/import/route.ts", "src/components/career/kit-import.tsx"]);
});

test("MCP exposes only redacted career schemas and the registered read capabilities", async () => {
  const career = importedTargets("src/lib/mcp").filter(({ to }) => CAREER.some((directory) => to.startsWith(`${directory}/`)));
  expect(career).toEqual([
    { file: "src/lib/mcp/dto/career.ts", to: "src/lib/career/contact/redact-profile.ts" },
    { file: "src/lib/mcp/dto/career.ts", to: "src/lib/career/document/redact.ts" },
    { file: "src/lib/mcp/dto/career.ts", to: "src/lib/career/tailor/proposal-schema.ts" },
  ]);
  const { CAPABILITIES } = await import("@/lib/capabilities/registry");
  expect(CAPABILITIES.map((capability) => capability.id)).toEqual(["search_jobs", "get_job", "list_applications", "get_profile", "get_interests", "preview_deal_breakers", "preview_interest_category", "get_today", "list_companies", "get_company", "get_insights", "get_application", "list_favorites", "get_application_context", "save_application_answer", "get_career_profile", "list_career_documents", "get_career_document", "check_career_document", "list_replies"]);
});
