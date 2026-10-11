/**
 * The language catalog, generated from the messages files.
 *
 *   pnpm i18n:catalog            write src/i18n/catalog.generated.ts and src/i18n/messages.generated.ts
 *   pnpm i18n:check              fail when a messages file is invalid or the generated files are out of date
 *
 * Every `messages/<id>.json` is one interface language. Its `meta` namespace names the language (own name, Intl tag, the
 * name a prompt uses, wide characters) and its `format` namespace holds the words of the format functions. The core
 * languages (en, zh) must have every key; any other language may leave keys out (they fall back to English) but must not
 * have keys English lacks, and every message must use the same ICU placeholders as the English one.
 * Adding a language = adding a messages file and running this script; no hand-written code changes.
 *
 * `--dir <dir>` reads another messages directory and `--out <dir>` writes elsewhere (tests). Exit codes: 0 done / up to
 * date, 1 invalid messages or stale generated files, 2 bad arguments.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { deepMergeMessages } from "../src/i18n/merge";
import { CORE_LOCALES, FALLBACK_LOCALE, formatLabelsSchema, LOCALE_ID_PATTERN, localeMetaSchema, type FormatLabels, type LocaleMeta } from "../src/i18n/catalog-schema";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_FILE = "catalog.generated.ts";
export const BUNDLED_FILE = "messages.generated.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every leaf of a messages tree as `dotted.key -> value`. */
export function messageLeaves(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isObject(value)) {
    out.set(prefix, value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    for (const [leaf, text] of messageLeaves(child, prefix === "" ? key : `${prefix}.${key}`)) out.set(leaf, text);
  }
  return out;
}

/**
 * The ICU argument names a message uses (`{count}`, `{count, plural, one {…} other {…}}`), sorted. A small reader of the
 * ICU syntax: the bodies of plural / select options are messages again, so `{was}` inside `one {was}` is text, not an argument.
 */
export function placeholders(text: string): string[] {
  const names = new Set<string>();
  let i = 0;
  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  };
  const readWord = (): string => {
    const start = i;
    while (i < text.length && /[^\s,{}]/.test(text[i] ?? "")) i += 1;
    return text.slice(start, i);
  };
  /** Text until the closing `}` of the enclosing option (or the end); arguments are collected on the way. */
  const message = (nested: boolean): void => {
    while (i < text.length) {
      const ch = text[i];
      if (ch === "'" && text[i + 1] === "'") i += 2;
      else if (ch === "'" && (text[i + 1] === "{" || text[i + 1] === "}")) {
        const end = text.indexOf("'", i + 1);
        i = end === -1 ? text.length : end + 1;
      } else if (ch === "{") {
        i += 1;
        argument();
      } else if (ch === "}" && nested) return;
      else i += 1;
    }
  };
  const argument = (): void => {
    skipSpace();
    const name = readWord();
    if (name !== "") names.add(name);
    skipSpace();
    if (text[i] === "}") {
      i += 1;
      return;
    }
    if (text[i] !== ",") return;
    i += 1;
    skipSpace();
    const type = readWord();
    skipSpace();
    if (text[i] === ",") i += 1;
    if (type === "plural" || type === "select" || type === "selectordinal") {
      for (;;) {
        skipSpace();
        if (i >= text.length) return;
        if (text[i] === "}") {
          i += 1;
          return;
        }
        readWord(); // option key (`one`, `=0`, `offset:1` …)
        skipSpace();
        if (text[i] === "{") {
          i += 1;
          message(true);
          i += 1; // the option's closing brace
        }
      }
    }
    // number / date / time with a style: skip to the closing brace
    while (i < text.length && text[i] !== "}") i += 1;
    i += 1;
  };
  message(false);
  return [...names].sort();
}

export interface CatalogLocale {
  id: string;
  meta: LocaleMeta;
  format: FormatLabels;
}

export interface CatalogResult {
  locales: CatalogLocale[];
  /** One line per problem; empty when the messages are valid. */
  problems: string[];
  /** Generated file name -> text. Empty when there are problems. */
  files: Record<string, string>;
}

/** Read and check every messages file of `dir`; on success render the generated files (imports relative to `outDir`). */
export function buildCatalog(dir: string, outDir: string): CatalogResult {
  const problems: string[] = [];
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const raw = new Map<string, unknown>();
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    if (!LOCALE_ID_PATTERN.test(id)) {
      problems.push(`${name}: the file name is not a language id (en, zh, pt-BR)`);
      continue;
    }
    try {
      raw.set(id, JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  }
  const base = raw.get(FALLBACK_LOCALE);
  if (!isObject(base)) return { locales: [], problems: [...problems, `${FALLBACK_LOCALE}.json: missing (every other language falls back to it)`], files: {} };
  const baseLeaves = messageLeaves(base);

  const locales: CatalogLocale[] = [];
  for (const [id, messages] of raw) {
    if (!isObject(messages)) {
      problems.push(`${id}.json: not an object`);
      continue;
    }
    const leaves = messageLeaves(messages);
    for (const [key, value] of leaves) {
      if (!baseLeaves.has(key)) problems.push(`${id}.json: ${key} is not in ${FALLBACK_LOCALE}.json`);
      else if (key === "meta.wide") continue;
      else if (typeof value !== "string" || value.trim() === "") problems.push(`${id}.json: ${key} must be a non-empty string`);
      else if (placeholders(value).join() !== placeholders(String(baseLeaves.get(key))).join()) problems.push(`${id}.json: ${key} uses other placeholders than ${FALLBACK_LOCALE}.json`);
    }
    if ((CORE_LOCALES as readonly string[]).includes(id)) {
      for (const key of baseLeaves.keys()) if (!leaves.has(key)) problems.push(`${id}.json: ${key} is missing (a core language has every key)`);
    }
    const meta = localeMetaSchema.safeParse(messages.meta);
    if (!meta.success) problems.push(`${id}.json: meta: ${meta.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`);
    const format = formatLabelsSchema.safeParse(deepMergeMessages(base.format, messages.format));
    if (!format.success) problems.push(`${id}.json: format: ${format.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`);
    if (meta.success && format.success) locales.push({ id, meta: meta.data, format: format.data });
  }
  for (const core of CORE_LOCALES) if (!raw.has(core)) problems.push(`${core}.json: missing (a core language)`);
  if (problems.length > 0) return { locales, problems, files: {} };

  const importPath = (id: string): string => {
    const relative = path.relative(outDir, path.join(dir, `${id}.json`)).split(path.sep).join("/");
    return relative.startsWith(".") ? relative : `./${relative}`;
  };
  const ids = locales.map((locale) => locale.id);
  const header = "// Generated by `pnpm i18n:catalog` from the messages files. Do not edit: change messages/*.json and run it again.\n";
  const record = (pick: (locale: CatalogLocale) => unknown): string =>
    `{\n${locales.map((locale) => `  ${JSON.stringify(locale.id)}: ${JSON.stringify(pick(locale))},`).join("\n")}\n}`;

  const catalog = [
    header,
    'import type { FormatLabels, LocaleMeta } from "./catalog-schema";',
    "",
    "/** Every interface language: one per messages file, sorted by id. */",
    `export const LOCALES = ${JSON.stringify(ids)} as const;`,
    "export type Locale = (typeof LOCALES)[number];",
    "",
    "/** Name, Intl tag, prompt name and character width of each language (`meta` of its messages file). */",
    `export const LOCALE_META: Readonly<Record<Locale, LocaleMeta>> = ${record((locale) => locale.meta)};`,
    "",
    "/** The words of the format functions (`format` of each messages file, missing ones from English). */",
    `export const FORMAT_LABELS: Readonly<Record<Locale, FormatLabels>> = ${record((locale) => locale.format)};`,
    "",
    "/** Each language's messages, loaded on demand (one chunk per language). `loadMessages` merges a non-core language over English. */",
    "export const MESSAGE_LOADERS: Readonly<Record<Locale, () => Promise<unknown>>> = {",
    ...ids.map((id) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(importPath(id))}).then((module: { default: unknown }) => module.default),`),
    "};",
    "",
  ].join("\n");

  const bundled = [
    header,
    "// Server and Node only (runner, ai-worker, CLI): every language bundled, read synchronously. Never import it from a client component.",
    ...ids.map((id) => `import ${identifier(id)} from ${JSON.stringify(importPath(id))};`),
    "",
    'import type { Locale } from "./catalog.generated";',
    "",
    `export const BUNDLED_MESSAGES: Readonly<Record<Locale, unknown>> = { ${ids.map((id) => `${JSON.stringify(id)}: ${identifier(id)}`).join(", ")} };`,
    "",
  ].join("\n");

  return { locales, problems, files: { [CATALOG_FILE]: catalog, [BUNDLED_FILE]: bundled } };
}

function identifier(id: string): string {
  return `messages_${id.replace(/-/g, "_")}`;
}

function main(): number {
  let values: { check?: boolean; dir?: string; out?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ options: { check: { type: "boolean" }, dir: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true }));
  } catch (error) {
    console.error(`i18n:catalog: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }
  if (values.help) {
    console.log("Usage: pnpm i18n:catalog [--check] [--dir <messages dir>] [--out <dir>]");
    return 0;
  }
  const dir = path.resolve(values.dir ?? path.join(APP_ROOT, "messages"));
  const outDir = path.resolve(values.out ?? path.join(APP_ROOT, "src", "i18n"));
  const result = buildCatalog(dir, outDir);
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`✗ ${problem}`);
    console.error(`${result.problems.length} problem(s) in ${path.relative(process.cwd(), dir) || dir}`);
    return 1;
  }
  const stale = Object.entries(result.files).filter(([name, text]) => {
    try {
      return fs.readFileSync(path.join(outDir, name), "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (values.check) {
    for (const [name] of stale) console.error(`✗ ${name} is out of date: run pnpm i18n:catalog`);
    if (stale.length > 0) return 1;
    console.log(`i18n ok: ${result.locales.map((locale) => `${locale.id} (${locale.meta.name})`).join(", ")}`);
    return 0;
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, text] of stale) fs.writeFileSync(path.join(outDir, name), text, "utf8");
  console.log(`${stale.length === 0 ? "catalog up to date" : `wrote ${stale.map(([name]) => name).join(", ")}`}: ${result.locales.map((locale) => locale.id).join(", ")}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main());
