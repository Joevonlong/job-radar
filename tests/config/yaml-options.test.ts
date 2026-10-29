import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Document } from "yaml";

import { ConfigError, parseConfigText } from "@/lib/config";
import { changedKeyPaths } from "@/lib/config/diff";
import { planConfigMigrations } from "@/lib/config/migrations/files";
import { maskConfigText } from "@/lib/config/secrets-mask";
import { validateConfigText } from "@/lib/config/validate-text";
import { writeConfig } from "@/lib/config/write";
import {
  CONFIG_YAML_OPTIONS,
  containsUnset,
  parseConfigYaml,
  parseConfigYamlDocument,
  stringifyConfigYaml,
  UNSET,
  UNSET_NOT_SUPPORTED,
} from "@/lib/config/yaml-options";
import { parseImportText } from "@/lib/sources/registry/import";

import { makeTempConfig, type TempConfig } from "./helpers";

const ROOT = path.resolve(import.meta.dirname, "../..");

function errorsOf(text: string, unset: "reject" | "overlay" = "overlay"): { line: number; message: string }[] {
  return parseConfigYamlDocument(text, { unset }).errors.map((error) => ({ line: error.linePos?.[0]?.line ?? 0, message: error.message.split("\n")[0] ?? "" }));
}

describe("tags", () => {
  it.each([
    ["an unregistered tag", "a: 1\nb: !foo 2\n", 2, /Unresolved tag: !foo/],
    ["a misspelt marker", "a:\n  b: !unsett\n", 2, /Unresolved tag: !unsett/],
    ["a core tag that does not fit the value", "a: 1\nb: !!int x\n", 2, /Unresolved tag/],
  ])("%s is an error with its line", (_label, text, line, message) => {
    const errors = errorsOf(text);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(line);
    expect(errors[0]?.message).toMatch(message);
    expect(() => parseConfigYaml(text)).toThrow(message);
  });

  it("keeps the standard tags and other warnings as they were", () => {
    expect(parseConfigYaml("a: !!str 1\n")).toEqual({ a: "1" });
    expect(parseConfigYamlDocument("a: 1\n").errors).toEqual([]);
  });
});

describe("!unset positions", () => {
  it.each([
    ["on a mapping", "a: 1\nb: !unset\n  c: 1\n", 2, /cannot mark a mapping or a list/],
    ["on a list", "a: 1\nb: !unset [1]\n", 2, /cannot mark a mapping or a list/],
    ["on a flow mapping", "b: !unset {c: 1}\n", 1, /cannot mark a mapping or a list/],
    ["in a list", "a:\n  - x\n  - !unset\n", 3, /cannot stand in a list/],
    ["in a mapping inside a list", "a:\n  - b: !unset\n", 2, /cannot stand in a list/],
    ["on the root", "!unset\n", 1, /cannot replace the whole file/],
    ["on config_version", "config_version: !unset\na: 1\n", 1, /config_version cannot be unset/],
    ["with a value", "a:\n  b: !unset x\n", 2, /takes no value/],
    ["with a quoted empty value", "a:\n  b: !unset ''\n", 2, /takes no value/],
    ["as a key", "a:\n  ? !unset\n  : 1\n", 2, /cannot be a key/],
    ["through an alias", "a: &m !unset\nb:\n  - *m\n", 3, /through an alias/],
  ])("%s is an error with its line", (_label, text, line, message) => {
    const errors = errorsOf(text);
    expect(errors.length).toBeGreaterThan(0);
    const found = errors.find((error) => message.test(error.message));
    expect(found, JSON.stringify(errors)).toBeDefined();
    expect(found?.line).toBe(line);
  });

  it("parses a marker on a key's value to UNSET in overlay mode", () => {
    expect(errorsOf("a:\n  b: !unset\n  c: 1\nd: !unset # gone\n")).toEqual([]);
    const value = parseConfigYaml("a:\n  b: !unset\n  c: 1\n", { unset: "overlay" });
    expect(value).toEqual({ a: { b: UNSET, c: 1 } });
    expect(containsUnset(value)).toBe(true);
  });

  it("refuses every marker while the overlay semantics are off (this version), with the line", () => {
    const errors = errorsOf("a: 1\nb:\n  c: !unset\n", "reject");
    expect(errors).toEqual([{ line: 3, message: expect.stringContaining(UNSET_NOT_SUPPORTED) as unknown as string }]);
    expect(() => parseConfigYaml("a: !unset\n")).toThrow(UNSET_NOT_SUPPORTED);
  });

  it("reads a quoted \"!unset\" as a plain string", () => {
    expect(parseConfigYaml('a: "!unset"\nb: \'!unset\'\n')).toEqual({ a: "!unset", b: "!unset" });
  });

  it("switches a key between the marker and a value without leaking state", () => {
    expect(parseConfigYaml("a: !unset\n", { unset: "overlay" })).toEqual({ a: UNSET });
    expect(parseConfigYaml("a: 1\n", { unset: "overlay" })).toEqual({ a: 1 });
    expect(parseConfigYaml("a: !unset\n", { unset: "overlay" })).toEqual({ a: UNSET });
    expect(parseConfigYaml("a: x\nb: !unset\n", { unset: "overlay" })).toEqual({ a: "x", b: UNSET });
    expect(parseConfigYaml("a: !unset\nb: x\n", { unset: "overlay" })).toEqual({ a: UNSET, b: "x" });
  });
});

describe("canonical text", () => {
  it("writes a marker as `key: !unset` with nothing after it", () => {
    const doc = new Document({ translation: { glossary: { "Product Manager": UNSET, Engineer: "Ingenieur" } }, scoring: { language_penalty: { B2: UNSET } } }, CONFIG_YAML_OPTIONS);
    expect(stringifyConfigYaml(doc)).toMatchInlineSnapshot(`
      "translation:
        glossary:
          Product Manager: !unset
          Engineer: Ingenieur
      scoring:
        language_penalty:
          B2: !unset
      "
    `);
  });

  it("normalises a parsed marker and keeps comments", () => {
    const doc = parseConfigYamlDocument("# head\na:\n  b: !unset   # dropped from the default\n  c: 1\n", { unset: "overlay" });
    const text = stringifyConfigYaml(doc);
    expect(text).toBe("# head\na:\n  b: !unset # dropped from the default\n  c: 1\n");
    expect(parseConfigYaml(text, { unset: "overlay" })).toEqual({ a: { b: UNSET, c: 1 } });
    // the document itself is not changed
    expect(doc.toString()).toContain("b: !unset ");
  });

  it("leaves a document without markers as yaml writes it", () => {
    const doc = parseConfigYamlDocument("a: 1\nb: [x, y]\n");
    expect(stringifyConfigYaml(doc)).toBe(doc.toString());
  });
});

describe("every config reader uses the shared options", () => {
  let temp: TempConfig | null = null;
  afterEach(() => {
    temp?.cleanup();
    temp = null;
  });

  const BAD = "timezone: !tz Europe/Berlin\n";

  it("no reader of config text parses YAML on its own", () => {
    const files = [
      "src/lib/config/load.ts",
      "src/lib/config/write.ts",
      "src/lib/config/validate-text.ts",
      "src/lib/config/diff.ts",
      "src/lib/config/examples.ts",
      "src/lib/config/secrets-mask.ts",
      "src/lib/config/migrations/files.ts",
      "src/lib/settings/advanced/view.ts",
      "src/lib/sources/registry/import.ts",
      "src/lib/sources/registry/service.ts",
    ];
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      const imported = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"yaml"/g)].flatMap((match) => (match[1] ?? "").split(",").map((name) => name.trim()));
      expect(imported, file).not.toContain("parse");
      expect(imported, file).not.toContain("parseAllDocuments");
      // `parseDocument` from yaml is allowed only with the shared options (the salvage of a broken file)
      if (imported.includes("parseDocument")) for (const match of text.matchAll(/\bparseDocument\(([^)]*)\)/g)) expect(match[1], file).toContain("CONFIG_YAML_OPTIONS");
    }
    const migrationDir = path.join(ROOT, "src/lib/config/migrations");
    for (const entry of fs.readdirSync(migrationDir, { recursive: true, encoding: "utf8" })) {
      if (!entry.endsWith(".ts")) continue;
      expect(fs.readFileSync(path.join(migrationDir, entry), "utf8"), entry).not.toMatch(/import\s*\{[^}]*\bparse(Document|AllDocuments)?\b[^}]*\}\s*from\s*"yaml"/);
    }
  });

  it("the loader, the editor, diff, the source import and the secrets mask refuse a bad tag", () => {
    temp = makeTempConfig();
    expect(() => parseConfigText("schedule", BAD, "schedule.yaml")).toThrow(ConfigError);
    try {
      parseConfigText("schedule", BAD, "schedule.yaml");
    } catch (error) {
      expect(error).toMatchObject({ kind: "yaml" });
      expect((error as Error).message).toMatch(/line 1, column 11/);
    }
    const validated = validateConfigText("schedule", BAD);
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.issues[0]).toMatchObject({ source: "yaml", line: 1 });
    expect(changedKeyPaths("a: 1\n", "a: !foo 1\n")).toBeNull();
    const imported = parseImportText("ats_boards: !foo []\n", "yaml", 100_000);
    expect(imported).toMatchObject({ ok: false, errors: [{ code: "invalid_yaml_at", values: { line: 1 } }] });
    // the proxy entries cannot be located in a text that does not parse: every URL is masked
    expect(maskConfigText("channels", "jobspy:\n  proxies: [!foo http://u:p@h]\n")).not.toContain("u:p@");
  });

  it("the migration plan reports a !unset in a user file as not supported; a save does not carry a bad tag over", async () => {
    temp = makeTempConfig();
    const file = path.join(temp.configDir, "schedule.yaml");
    fs.writeFileSync(file, "timezone: UTC\nbackup:\n  keep_daily: !unset\n");
    const plan = planConfigMigrations(["schedule"]);
    expect(plan.problems).toEqual([expect.objectContaining({ name: "schedule", message: expect.stringContaining(UNSET_NOT_SUPPORTED) as unknown as string })]);
    // a save over a file the reader refuses starts from a fresh document: the bad tag is not carried over
    const shipped = fs.readFileSync(path.join(temp.defaultsDir, "schedule.yaml"), "utf8");
    fs.writeFileSync(file, `${shipped}\nextra: !foo 1\n`);
    await writeConfig("schedule", parseConfigText("schedule", shipped));
    expect(fs.readFileSync(file, "utf8")).not.toContain("!foo");
  });
});
