/**
 * Fill the user config directory. `user` files missing there are copied from the defaults directory (or from
 * `from`); existing files are never overwritten, so this is safe to run on every start (`pnpm config:init`, web and
 * runner start-up). With `from` (the one-time production switch-over: `pnpm config:init --from config`) the `shipped`
 * files whose content differs from the shipped default are copied too, so nothing the old single directory held is lost.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { isExistingInstall } from "./install";
import { EXISTING_INSTALL_LANGUAGE_YAML } from "./migrations/language/existing-install";
import { getConfigDir, getDefaultsDir } from "./paths";
import { configRegistry, LAYERED_CONFIG_NAMES, type ConfigName } from "./registry";
import { copyPrivateIfMissing } from "./private-file";

export interface EnsureConfigOptions {
  /** Copy from this directory instead of the defaults directory (absolute, or relative to the working directory). */
  from?: string;
  /** The time an existing install's setup.yaml is stamped with (tests); default now. */
  now?: Date;
}

export interface EnsureConfigResult {
  name: ConfigName;
  /** The file in the user directory. */
  path: string;
  /** Copied now. */
  created: boolean;
  /**
   * Why it was copied (or would have been): `user` file, a `shipped` file the source changed (an override), or `upgrade`: a
   * file this version introduced, written with the earlier behaviour because the install is not new (language.yaml),
   * or `existing_install`: setup.yaml written as "completed" because the directory already held config files.
   */
  reason: "user" | "override" | "upgrade" | "existing_install" | null;
  /** The file it was copied from; null when nothing was copied. */
  source: string | null;
  /** A `user` file that neither the user directory nor the source has (config:check reports it). */
  missing: boolean;
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(/*turbopackIgnore: true*/ file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Copy `source` to `target` unless `target` exists (owner-only from the start). True when it copied. */
async function copyIfMissing(source: string, target: string): Promise<boolean> {
  return copyPrivateIfMissing(source, target);
}

/** Write `text` to `target` unless `target` exists. True when it wrote. */
async function writeIfMissing(target: string, text: string): Promise<boolean> {
  try {
    await fsp.writeFile(/*turbopackIgnore: true*/ target, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    if (code === "EEXIST") return false;
    throw err;
  }
}

/** setup.yaml of an install from before the setup wizard: completed, so it never opens the wizard or pauses the runner. */
export function existingInstallSetupYaml(now: Date): string {
  return [
    "# First-run setup (docs/setup.md). This install had config files before the setup wizard existed, so it was marked",
    "# complete on its first start. Open /setup (or run `pnpm run setup`) any time to walk through the steps again.",
    "config_version: 1",
    `completed_at: "${now.toISOString()}"`,
    "completed_by: existing_install",
    "",
  ].join("\n");
}

/**
 * Copy the missing `user` files (and, with `from`, the changed `shipped` ones) into the user config directory.
 * Never overwrites. Does nothing (and needs no write access) when every file is already there.
 */
export async function ensureConfigFiles(options: EnsureConfigOptions = {}): Promise<EnsureConfigResult[]> {
  const userDir = getConfigDir();
  const defaultsDir = getDefaultsDir();
  const from = options.from === undefined ? defaultsDir : path.resolve(options.from);
  const switchOver = path.resolve(from) !== path.resolve(defaultsDir);
  const results: EnsureConfigResult[] = [];
  // decided before anything is copied: a directory that held config files before this run is an existing install
  const existingInstall = isExistingInstall(userDir) || (switchOver && isExistingInstall(from));
  let dirReady = fs.existsSync(/*turbopackIgnore: true*/ userDir);
  const ensureDir = async (): Promise<void> => {
    if (dirReady) return;
    await fsp.mkdir(/*turbopackIgnore: true*/ userDir, { recursive: true });
    dirReady = true;
  };

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
      await ensureDir();
      result.created = await copyIfMissing(source, target);
      result.reason = "override";
      result.source = source;
      continue;
    }

    // An install from before language.yaml existed keeps its languages (Chinese), a fresh one gets the shipped default
    // (with `from`, a directory that has its own language.yaml is copied as usual)
    if (name === "language" && existingInstall && !(switchOver && fs.existsSync(/*turbopackIgnore: true*/ path.join(from, entry.file)))) {
      await ensureDir();
      result.created = await writeIfMissing(target, EXISTING_INSTALL_LANGUAGE_YAML);
      result.reason = "upgrade";
      continue;
    }

    // An install from before the wizard is never sent into it (with `from`, a directory that has its own setup.yaml is copied as usual)
    if (name === "setup" && existingInstall && !(switchOver && fs.existsSync(/*turbopackIgnore: true*/ path.join(from, entry.file)))) {
      await ensureDir();
      result.created = await writeIfMissing(target, existingInstallSetupYaml(options.now ?? new Date()));
      result.reason = "existing_install";
      continue;
    }

    // with `from`, a file that directory lacks (an older checkout) comes from the defaults
    const file = entry.file;
    const source = [path.join(from, file), path.join(defaultsDir, file)].find((candidate) => fs.existsSync(/*turbopackIgnore: true*/ candidate));
    if (source === undefined) {
      result.missing = true;
      continue;
    }
    await ensureDir();
    result.created = await copyIfMissing(source, target);
    result.reason = "user";
    result.source = source;
  }
  return results;
}
