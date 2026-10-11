// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { buildCatalog, messageLeaves, placeholders } from "../scripts/i18n-catalog";
import { CORE_LOCALES } from "@/i18n/catalog-schema";

const MESSAGES_DIR = path.resolve(import.meta.dirname, "../messages");
const FILES = fs.readdirSync(MESSAGES_DIR).filter((name) => name.endsWith(".json"));
const load = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, name), "utf8"));
const en = messageLeaves(load("en.json"));

describe("messages", () => {
  it("the detail-page translate button names the configured target through {language}, in every locale", () => {
    for (const name of FILES) {
      const value = messageLeaves(load(name)).get("dashboard.detail.actions.translate");
      expect(value, name).toContain("{language}");
    }
  });

  it("are valid for the catalog (meta, format, keys, placeholders)", () => {
    const result = buildCatalog(MESSAGES_DIR, path.resolve(import.meta.dirname, "../src/i18n"));
    expect(result.problems).toEqual([]);
    expect(result.locales.map((locale) => locale.id).sort()).toEqual(FILES.map((name) => name.replace(/\.json$/, "")).sort());
  });

  it.each(CORE_LOCALES)("core language %s has exactly the English keys", (id) => {
    expect([...messageLeaves(load(`${id}.json`)).keys()].sort()).toEqual([...en.keys()].sort());
  });

  it.each(FILES)("%s has no empty strings (meta.wide is the only non-string)", (name) => {
    for (const [key, value] of messageLeaves(load(name))) {
      if (key === "meta.wide") {
        expect(typeof value, `${name}:${key}`).toBe("boolean");
        continue;
      }
      expect(typeof value, `${name}:${key}`).toBe("string");
      expect((value as string).trim().length, `${name}:${key}`).toBeGreaterThan(0);
    }
  });

  it.each(FILES)("%s uses the same ICU placeholders as English", (name) => {
    for (const [key, value] of messageLeaves(load(name))) {
      if (typeof value !== "string") continue;
      expect(placeholders(value), `${name}:${key}`).toEqual(placeholders(String(en.get(key))));
    }
  });

  it.each(FILES)("%s: every message formats without an ICU error (no stray <tags>, balanced braces)", (name) => {
    const messages = load(name) as Record<string, unknown>;
    const errors: string[] = [];
    const t = createTranslator({ locale: "en", messages, onError: (error) => errors.push(error.message) });
    for (const [key, value] of messageLeaves(messages)) {
      if (typeof value !== "string" || key.startsWith("meta.") || key.startsWith("format.")) continue;
      const args = Object.fromEntries(placeholders(value).map((arg) => [arg, 1]));
      const tags = [...value.matchAll(/<(\w+)>/g)].map((match) => match[1] ?? "");
      const before = errors.length;
      if (tags.length > 0) t.markup(key as never, { ...args, ...Object.fromEntries(tags.map((tag) => [tag, (chunks: string) => chunks])) } as never);
      else t(key as never, args as never);
      if (errors.length > before) errors[errors.length - 1] = `${key}: ${errors[errors.length - 1]}`;
    }
    expect(errors).toEqual([]);
  });

  it("the generated catalog is up to date", () => {
    const outDir = path.resolve(import.meta.dirname, "../src/i18n");
    const result = buildCatalog(MESSAGES_DIR, outDir);
    for (const [name, text] of Object.entries(result.files)) expect(fs.readFileSync(path.join(outDir, name), "utf8"), `${name}: run pnpm i18n:catalog`).toBe(text);
  });
});
