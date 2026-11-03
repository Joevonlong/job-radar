/**
 * Fill the user config directory. `user` files missing there are copied from the defaults directory (or from `from`);
 * existing files are never overwritten, so this is safe to run again. Runs from deploys and `pnpm config:init`, never at
 * start-up, and each file is committed under the config write lock, so it needs the database when a file is missing.
 *
 * setup.yaml and language.yaml are the setup wizard's: a missing setup.yaml means the wizard is pending, so they are not
 * created here. With `from` (the one-time production switch-over `pnpm config:init --from config`, or an unpacked archive)
 * those two are copied like the rest when `from` has them, the `shipped` files whose content differs from the shipped
 * default are copied too, and a directory from before the wizard gets its completed setup.yaml (see `backfill`).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { readArchiveSetupSemantics } from "../ops/config-archive";
import { existingInstallSetupYaml, EXISTING_INSTALL_LANGUAGE_YAML } from "../setup/existing-install";

import { commitConfigFile } from "./atomic";
import { installedConfigFiles } from "./install";
import { getConfigDir, getDefaultsDir } from "./paths";
import { copyPrivateIfMissing } from "./private-file";
import { readUserText } from "./read-user-file";
import { configRegistry, LAYERED_CONFIG_NAMES, type ConfigName } from "./registry";
import { withFileLock } from "./write";
import { withConfigWriteLock } from "./write-lock";


export interface EnsureConfigOptions {
  /** Copy from this directory instead of the defaults directory (absolute, or relative to the working directory). */
  from?: string;
  /** The time a backfilled setup.yaml is stamped with (tests); default now. */
  now?: Date;
}

export interface EnsureConfigResult {
  name: ConfigName;
  /** The file in the user directory. */
  path: string;
  /** Copied now. */
  created: boolean;
  /**
   * Why it was copied (or would have been): `user` file, a `shipped` file the source changed (an override), or `backfill`:
   * written because `from` is a directory from before the setup wizard.
   */
  reason: "user" | "override" | "backfill" | null;
  /** The file it was copied from; null when nothing was copied. */
  source: string | null;
  /** A `user` file that neither the user directory nor the source has (config:check reports it). */
  missing: boolean;
}

/** The files the wizard owns; never created by a fill. */
const WIZARD_FILES: readonly ConfigName[] = ["setup", "language"];

async function readOrNull(file: string): Promise<string | null> {
  try {
    return readUserText(file);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Write `text` to `target` unless `target` exists. True when it wrote. */
function writeIfMissing(target: string, text: string): Promise<boolean> {
  return withFileLock(target, () => withConfigWriteLock(async () => (await commitConfigFile(target, text, { mode: "create" })) === "written", target));
}

/**
 * Does `from` predate the setup wizard? Only a directory with no archive marker, some layered file and no setup.yaml, going
 * into a user directory that has none either. A marked archive without setup.yaml is restored as it is (wizard pending).
 */
function backfill(from: string, userDir: string): boolean {
  return readArchiveSetupSemantics(from) === "none"
    && installedConfigFiles(from).length > 0
    && !fs.existsSync(/*turbopackIgnore: true*/ path.join(from, configRegistry.setup.file))
    && !fs.existsSync(/*turbopackIgnore: true*/ path.join(userDir, configRegistry.setup.file));
}

/** The `user` files a fill would create now (`planConfigWrites`). Reads only. */
export function plannedConfigFiles(): { name: ConfigName; path: string }[] {
  const userDir = getConfigDir();
  const defaultsDir = getDefaultsDir();
  return LAYERED_CONFIG_NAMES
    .filter((name) => configRegistry[name].kind === "user" && !WIZARD_FILES.includes(name))
    .map((name) => ({ name, path: path.join(userDir, configRegistry[name].file), source: path.join(defaultsDir, configRegistry[name].file) }))
    .filter((file) => !fs.existsSync(/*turbopackIgnore: true*/ file.path) && fs.existsSync(/*turbopackIgnore: true*/ file.source))
    .map(({ name, path: file }) => ({ name, path: file }));
}

/**
 * Copy the missing `user` files (and, with `from`, the changed `shipped` ones) into the user config directory.
 * Never overwrites. Does nothing (and needs neither write access nor the database) when every file is already there.
 */
export async function ensureConfigFiles(options: EnsureConfigOptions = {}): Promise<EnsureConfigResult[]> {
  const userDir = getConfigDir();
  const defaultsDir = getDefaultsDir();
  const from = options.from === undefined ? defaultsDir : path.resolve(options.from);
  const switchOver = path.resolve(from) !== path.resolve(defaultsDir);
  const results: EnsureConfigResult[] = [];
  // decided before anything is copied
  const fromBeforeWizard = switchOver && backfill(from, userDir);

  // setup.yaml first: a process reading the directory while it fills sees the setup state before the other files
  for (const name of ["setup" as const, ...LAYERED_CONFIG_NAMES.filter((n) => n !== "setup")]) {
    const entry = configRegistry[name];
    const target = path.join(userDir, entry.file);
    const result: EnsureConfigResult = { name, path: target, created: false, reason: null, source: null, missing: false };
    results.push(result);
    if (fs.existsSync(/*turbopackIgnore: true*/ target)) continue;

    if (entry.kind === "shipped") {
      if (!switchOver) continue;
      const source = path.join(from, entry.file);
      const text = await readOrNull(source);
      if (text === null || text === (await readOrNull(path.join(defaultsDir, entry.file)))) continue;
      result.created = await copyPrivateIfMissing(source, target);
      result.reason = "override";
      result.source = source;
      continue;
    }

    if (WIZARD_FILES.includes(name)) {
      if (!switchOver) continue;
      const source = path.join(from, entry.file);
      if (fs.existsSync(/*turbopackIgnore: true*/ source)) {
        result.created = await copyPrivateIfMissing(source, target);
        result.reason = "user";
        result.source = source;
      } else if (fromBeforeWizard) {
        result.created = await writeIfMissing(target, name === "setup" ? existingInstallSetupYaml(options.now ?? new Date()) : EXISTING_INSTALL_LANGUAGE_YAML);
        result.reason = "backfill";
      }
      continue;
    }

    // with `from`, a file that directory lacks (an older checkout) comes from the defaults
    const file = entry.file;
    const source = [path.join(from, file), path.join(defaultsDir, file)].find((candidate) => fs.existsSync(/*turbopackIgnore: true*/ candidate));
    if (source === undefined) {
      result.missing = true;
      continue;
    }
    result.created = await copyPrivateIfMissing(source, target);
    result.reason = "user";
    result.source = source;
  }
  return results;
}
