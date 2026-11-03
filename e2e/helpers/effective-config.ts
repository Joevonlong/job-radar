import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

/**
 * What a config file amounts to: the shipped file with the user's file laid over it, key by key. For a spec that asserts
 * a value through the file, whatever a save left there (a key equal to the shipped value leaves the file).
 */
const UNSET = Symbol("unset");
const YAML_OPTIONS = { customTags: [{ tag: "!unset", resolve: () => UNSET }] };

const isMapping = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function overlay(base: unknown, over: unknown): unknown {
  if (!isMapping(base) || !isMapping(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === UNSET) delete out[key];
    else out[key] = overlay(base[key], value);
  }
  return out;
}

function readYaml(file: string): unknown {
  return fs.existsSync(file) ? (parse(fs.readFileSync(file, "utf8"), YAML_OPTIONS) as unknown) : {};
}

/** `fileName` with its extension (`sources.yaml`). */
export function layeredConfig<T = Record<string, unknown>>(defaultsDir: string, configDir: string, fileName: string): T {
  return overlay(readYaml(path.join(defaultsDir, fileName)), readYaml(path.join(configDir, fileName))) as T;
}

/** `layeredConfig` on the directories of the e2e run. */
export function effectiveConfig<T = Record<string, unknown>>(fileName: string): T {
  return layeredConfig<T>(process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults"), process.env.E2E_CONFIG_DIR ?? "", fileName);
}
