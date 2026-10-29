import fs from "node:fs";
import path from "node:path";

import type { Document } from "yaml";

import { parseConfigDocument } from "@/lib/config/load";
import { migrateConfigDocument, withoutConfigVersion } from "@/lib/config/migrations/version";
import { configRegistry, type ConfigName } from "@/lib/config/registry";
import { parseConfigYaml, parseConfigYamlDocument } from "@/lib/config/yaml-options";

import { FIXTURE_DEFAULTS_DIR } from "./helpers";

/** A config file of the fixture defaults, parsed and migrated (in memory). */
export function migratedDocument(name: ConfigName, text: string, filePath: string = configRegistry[name].file): Document {
  const doc = parseConfigDocument(name, text, filePath);
  migrateConfigDocument(name, doc, filePath);
  return doc;
}

/** The plain value of a migrated document without `config_version`, as the merge functions take it. */
export function plainValue(doc: Document): unknown {
  return withoutConfigVersion(doc.toJS());
}

export function fixtureText(name: ConfigName): string {
  return fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, configRegistry[name].file), "utf8");
}

/** The shipped value of a config in the fixture defaults (migrated, no `config_version`). */
export function shippedValue(name: ConfigName): unknown {
  return plainValue(migratedDocument(name, fixtureText(name)));
}

/** An overlay written as YAML (markers allowed). */
export function overlay(text: string): unknown {
  return parseConfigYaml(text, { unset: "overlay" });
}

/** An overlay document written as YAML (markers allowed). */
export function overlayDocument(text: string): Document {
  const doc = parseConfigYamlDocument(text, { unset: "overlay" });
  if (doc.errors[0]) throw doc.errors[0];
  return doc;
}

/** The zod output of a config value. */
export function effective(name: ConfigName, value: unknown): unknown {
  return configRegistry[name].schema.parse(value);
}
