/**
 * Example setups: ready-made search setups shipped in `<defaults dir>/examples/<id>/` (keyword groups, title words,
 * company career boards, …) that a user can apply to their own config with `pnpm config:example <id>`. The shipped
 * defaults stay neutral; an example is opt-in.
 *
 * An example directory holds `example.yaml` (`name`, `description`) and partial copies of `user` config files
 * (`search.yaml`, `sources.yaml`, …) with only the keys the example sets. Applying one merges each partial file into the
 * file the app currently reads (maps key by key, lists replaced; `ats_boards` keeps the user's boards and adds the
 * missing ones; `keyword_groups` is replaced while it is still the shipped placeholder, like the setup wizard does),
 * validates the result and writes it to the user directory with comments kept.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { ConfigError, zodIssues } from "./errors";
import { readConfigText, parseConfigText, resetConfigCache } from "./load";
import { configBackupDir } from "./migrations/files";
import { getDefaultConfigPath, getDefaultsDir, getUserConfigPath, resolveConfigPath } from "./paths";
import { configRegistry, USER_CONFIG_NAMES, type ConfigName, type ConfigValue } from "./registry";
import { writeConfig } from "./write";
import { copyPrivateIfMissing } from "./private-file";
import { parseConfigYaml } from "./yaml-options";

export const EXAMPLES_DIR = "examples";
export const EXAMPLE_FILE = "example.yaml";

const exampleMetaSchema = z.strictObject({ name: z.string().trim().min(1), description: z.string().trim().min(1) });

export interface ConfigExampleInfo {
  id: string;
  name: string;
  description: string;
  dir: string;
}

export interface ConfigExample extends ConfigExampleInfo {
  /** The partial config files, in registry order. */
  files: { name: ConfigName; path: string; patch: Record<string, unknown> }[];
}

/** One file an example changes: the value the app reads now and the value after applying. */
export interface ConfigExampleChange<N extends ConfigName = ConfigName> {
  name: N;
  /** The file that is written (always the user directory). */
  path: string;
  before: ConfigValue<N>;
  after: ConfigValue<N>;
  /** Dotted paths that differ (objects are walked, lists compared whole). Empty = nothing changes. */
  changed: string[];
  /** Lists whose current (non-empty) entries the example replaces: what is in them now is dropped. */
  replaced: string[];
}

export class ConfigExampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigExampleError";
  }
}

/** `<defaults dir>/examples`. */
export function examplesDir(): string {
  return path.join(getDefaultsDir(), EXAMPLES_DIR);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYaml(file: string): unknown {
  try {
    return parseConfigYaml(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
  } catch (error) {
    throw new ConfigExampleError(`${file}: ${error instanceof Error ? (error.message.split("\n")[0] ?? "invalid YAML") : "unreadable"}`);
  }
}

function readInfo(id: string, dir: string): ConfigExampleInfo {
  const meta = exampleMetaSchema.safeParse(readYaml(path.join(dir, EXAMPLE_FILE)));
  if (!meta.success) throw new ConfigExampleError(`${path.join(dir, EXAMPLE_FILE)}: ${zodIssues(meta.error).map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`);
  return { id, dir, ...meta.data };
}

/** The examples in the defaults directory (directories with an `example.yaml`), sorted by id. */
export function listExamples(): ConfigExampleInfo[] {
  const base = examplesDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(/*turbopackIgnore: true*/ base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(/*turbopackIgnore: true*/ path.join(base, entry.name, EXAMPLE_FILE)))
    .map((entry) => readInfo(entry.name, path.join(base, entry.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Read an example; throws ConfigExampleError for an unknown id, a file that is not a `user` config, or bad YAML. */
export function readExample(id: string): ConfigExample {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ConfigExampleError(`"${id}" is not an example id`);
  const dir = path.join(examplesDir(), id);
  if (!fs.existsSync(/*turbopackIgnore: true*/ path.join(dir, EXAMPLE_FILE))) throw new ConfigExampleError(`no example "${id}" in ${examplesDir()}`);
  const info = readInfo(id, dir);
  const byFile = new Map<string, ConfigName>(USER_CONFIG_NAMES.map((name) => [configRegistry[name].file, name]));
  const files: ConfigExample["files"] = [];
  for (const file of fs.readdirSync(/*turbopackIgnore: true*/ dir).sort()) {
    if (file === EXAMPLE_FILE || !file.endsWith(".yaml")) continue;
    const name = byFile.get(file);
    if (name === undefined) throw new ConfigExampleError(`${path.join(dir, file)}: an example can only contain these files: ${[...byFile.keys()].join(", ")}`);
    const patch = readYaml(path.join(dir, file));
    if (!isPlainObject(patch)) throw new ConfigExampleError(`${path.join(dir, file)}: expected a map of keys`);
    files.push({ name, path: path.join(dir, file), patch });
  }
  files.sort((a, b) => USER_CONFIG_NAMES.indexOf(a.name) - USER_CONFIG_NAMES.indexOf(b.name));
  return { ...info, files };
}

/** Lists merged by identity instead of replaced: the user's entries stay, the example's missing ones are added. */
const MERGED_LISTS: Record<string, (item: unknown) => string | null> = {
  ats_boards: (item) => (isPlainObject(item) && typeof item.ats === "string" && typeof item.token === "string" ? `${item.ats}:${item.token.toLowerCase()}` : null),
};

/** Maps replaced as a whole while they still equal the shipped default (the default is a placeholder, not a choice). */
const REPLACED_WHILE_DEFAULT = new Set(["keyword_groups"]);

/**
 * Merge an example's partial value into a config value (see the module comment). Pure. `shipped` is the same config's
 * shipped default (undefined = unknown: placeholder maps are merged like any other).
 */
export function mergeExample(base: unknown, patch: unknown, shipped?: unknown, at = "", replaced: string[] = []): unknown {
  if (REPLACED_WHILE_DEFAULT.has(at) && shipped !== undefined && isDeepStrictEqual(base, shipped)) return patch;
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = mergeExample(base[key], value, isPlainObject(shipped) ? shipped[key] : undefined, at === "" ? key : `${at}.${key}`, replaced);
    }
    return out;
  }
  const identity = MERGED_LISTS[at];
  if (identity !== undefined && Array.isArray(base) && Array.isArray(patch)) {
    const seen = new Set(base.map(identity).filter((key): key is string => key !== null));
    const added = patch.filter((item) => {
      const key = identity(item);
      if (key === null || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return [...base, ...added];
  }
  if (Array.isArray(base) && base.length > 0 && !isDeepStrictEqual(base, patch)) replaced.push(at);
  return patch;
}

function changedPaths(before: unknown, after: unknown, at: string, out: string[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) changedPaths(before[key], after[key], at === "" ? key : `${at}.${key}`, out);
    return;
  }
  if (!isDeepStrictEqual(before, after)) out.push(at);
}

function shippedValue(name: ConfigName): unknown {
  const file = getDefaultConfigPath(name);
  if (file === null) return undefined;
  try {
    return parseConfigText(name, fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"), file);
  } catch {
    return undefined;
  }
}

/** What applying an example would change, file by file. Reads the current files fresh; writes nothing. */
export function planExample(example: ConfigExample): ConfigExampleChange[] {
  return example.files.map(({ name, path: source, patch }) => {
    const before = parseConfigText(name, readConfigText(name), resolveConfigPath(name));
    const replaced: string[] = [];
    const merged = mergeExample(before, patch, shippedValue(name), "", replaced);
    const result = configRegistry[name].schema.safeParse(merged);
    if (!result.success) throw new ConfigError({ configName: name, filePath: source, kind: "schema", issues: zodIssues(result.error) });
    const after = result.data as ConfigValue<typeof name>;
    const changed: string[] = [];
    changedPaths(before, after, "", changed);
    return { name, path: getUserConfigPath(name), before, after, changed, replaced };
  });
}

export interface AppliedConfigExample {
  /** Where the user's previous files were copied; null when none existed or nothing changed. */
  backupDir: string | null;
  written: string[];
}

/** Write a plan: back up the user files that change to `<user dir>/.backup/<timestamp>/`, then write each one. */
export async function applyExamplePlan(plan: readonly ConfigExampleChange[], now: Date = new Date()): Promise<AppliedConfigExample> {
  const changes = plan.filter((change) => change.changed.length > 0);
  let backupDir: string | null = null;
  for (const change of changes) {
    if (!fs.existsSync(/*turbopackIgnore: true*/ change.path)) continue;
    backupDir ??= configBackupDir(now);
    await fsp.mkdir(/*turbopackIgnore: true*/ backupDir, { recursive: true });
    const copy = path.join(backupDir, path.basename(change.path));
    await copyPrivateIfMissing(change.path, copy);
  }
  const written: string[] = [];
  for (const change of changes) {
    await writeConfig(change.name, change.after);
    written.push(change.path);
  }
  resetConfigCache();
  return { backupDir, written };
}
