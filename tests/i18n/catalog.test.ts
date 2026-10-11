// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BUNDLED_FILE, buildCatalog, CATALOG_FILE, placeholders } from "../../scripts/i18n-catalog";
import { deepMergeMessages } from "@/i18n/merge";

const MESSAGES_DIR = path.resolve(import.meta.dirname, "../../messages");
const FR = path.resolve(import.meta.dirname, "fixtures/fr.json");
const dirs: string[] = [];

/** A messages directory with the real en / zh and the given extra files. */
function messagesDir(extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-messages-"));
  dirs.push(dir);
  for (const name of ["en.json", "zh.json"]) fs.copyFileSync(path.join(MESSAGES_DIR, name), path.join(dir, name));
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("i18n catalog generator", () => {
  it("lists one language per messages file, sorted, with meta and format", () => {
    const dir = messagesDir();
    const result = buildCatalog(dir, path.join(dir, "out"));
    expect(result.problems).toEqual([]);
    expect(result.locales.map((locale) => locale.id)).toEqual(["en", "zh"]);
    expect(result.files[CATALOG_FILE]).toContain('export const LOCALES = ["en","zh"] as const;');
    expect(result.files[BUNDLED_FILE]).toContain('import messages_zh from "../zh.json";');
  });

  it("adds a language from its messages file alone; missing keys and format words fall back to English", () => {
    const dir = messagesDir({ "fr.json": fs.readFileSync(FR, "utf8") });
    const result = buildCatalog(dir, path.join(dir, "out"));
    expect(result.problems).toEqual([]);
    expect(result.locales.map((locale) => locale.id)).toEqual(["en", "fr", "zh"]);
    const fr = result.locales.find((locale) => locale.id === "fr");
    expect(fr?.meta.name).toBe("Français");
    expect(fr?.format.relative.yesterday).toBe("hier");
    expect(fr?.format.duration.m).toBe("min");
    expect(result.files[CATALOG_FILE]).toContain('"fr": () => import("../fr.json")');
  });

  it("refuses a file without valid meta", () => {
    const dir = messagesDir({ "fr.json": JSON.stringify({ meta: { name: "Français", intl: "not a tag!", promptName: "French" } }) });
    const result = buildCatalog(dir, path.join(dir, "out"));
    expect(result.problems.join("\n")).toMatch(/fr\.json: meta: intl/);
    expect(result.problems.join("\n")).toMatch(/; wide /);
    expect(result.files).toEqual({});
  });

  it("refuses keys English lacks, other placeholders and a non-language file name", () => {
    const fr = JSON.parse(fs.readFileSync(FR, "utf8")) as Record<string, unknown>;
    const dir = messagesDir({
      "fr.json": JSON.stringify({ ...fr, nope: { key: "x" }, shell: { languageMenu: "Langue {oops}" } }),
      "French.json": "{}",
    });
    const problems = buildCatalog(dir, path.join(dir, "out")).problems.join("\n");
    expect(problems).toMatch(/fr\.json: nope\.key is not in en\.json/);
    expect(problems).toMatch(/fr\.json: shell\.languageMenu uses other placeholders/);
    expect(problems).toMatch(/French\.json: the file name is not a language id/);
  });

  it("refuses a core language with a missing key", () => {
    const zh = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, "zh.json"), "utf8")) as { shell: Record<string, unknown> };
    delete zh.shell.languageMenu;
    const dir = messagesDir();
    fs.writeFileSync(path.join(dir, "zh.json"), JSON.stringify(zh));
    expect(buildCatalog(dir, path.join(dir, "out")).problems).toContain("zh.json: shell.languageMenu is missing (a core language has every key)");
  });

  it("reads ICU argument names, including plural and select arguments", () => {
    expect(placeholders("{count, plural, one {# job} other {# jobs}} in {city}")).toEqual(["city", "count"]);
    expect(placeholders("no arguments")).toEqual([]);
  });

  it("merges a partial language over English", () => {
    expect(deepMergeMessages({ a: { b: "en-b", c: "en-c" }, d: "en-d" }, { a: { b: "fr-b" } })).toEqual({ a: { b: "fr-b", c: "en-c" }, d: "en-d" });
  });
});

describe("ICU placeholders", () => {
  it("does not count the text of plural options as arguments", () => {
    expect(placeholders("{count, plural, one {# run was} other {# runs were}} and {count, plural, one {was} other {were}}")).toEqual(["count"]);
    expect(placeholders("{a, select, x {{b}} other {c}} {d, number, ::percent}")).toEqual(["a", "b", "d"]);
    expect(placeholders("'{literal}' {real}")).toEqual(["real"]);
  });
});
