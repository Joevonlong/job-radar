/**
 * The state of the two config layers, for the doctor (`config.layers`) and `pnpm config:check`. Reads only.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";

import { planConfigMigrations } from "./migrations/files";
import { configLayer, displayConfigPath, getConfigDir, getDefaultsDir, getUserConfigPath } from "./paths";
import { configRegistry, LAYERED_CONFIG_NAMES, SHIPPED_CONFIG_NAMES, USER_CONFIG_NAMES } from "./registry";

export interface ConfigLayersState {
  /** For people (`config`, `data/config`, or absolute outside the app). */
  defaultsDir: string;
  userDir: string;
  userDirExists: boolean;
  /** null when it does not exist. */
  userDirWritable: boolean | null;
  /** How many config files the user directory holds. */
  userFiles: number;
  /** `user` files still read from the defaults (not copied yet: `pnpm config:init`). File names. */
  notCopied: string[];
  /** `shipped` files the user directory replaces (product updates of them no longer apply). File names. */
  overrides: string[];
  /** User files older than the code (migrated in memory on every load). */
  pendingMigrations: { file: string; from: number; to: number }[];
  /** User files that cannot be migrated: newer than the code (a downgrade) or an invalid `config_version`. */
  problems: { file: string; message: string }[];
}

export async function inspectConfigLayers(): Promise<ConfigLayersState> {
  const userDir = getConfigDir();
  const userDirExists = fs.existsSync(/*turbopackIgnore: true*/ userDir);
  let userDirWritable: boolean | null = null;
  if (userDirExists) {
    try {
      await fsp.access(/*turbopackIgnore: true*/ userDir, fs.constants.W_OK);
      userDirWritable = true;
    } catch {
      userDirWritable = false;
    }
  }
  const plan = planConfigMigrations();
  return {
    defaultsDir: displayConfigPath(getDefaultsDir()),
    userDir: displayConfigPath(userDir),
    userDirExists,
    userDirWritable,
    userFiles: LAYERED_CONFIG_NAMES.filter((name) => fs.existsSync(/*turbopackIgnore: true*/ getUserConfigPath(name))).length,
    notCopied: USER_CONFIG_NAMES.filter((name) => configLayer(name) === "default").map((name) => configRegistry[name].file),
    overrides: SHIPPED_CONFIG_NAMES.filter((name) => configLayer(name) === "user").map((name) => configRegistry[name].file),
    pendingMigrations: plan.pending.map((item) => ({ file: displayConfigPath(item.path), from: item.from, to: item.to })),
    problems: plan.problems.map((item) => ({ file: displayConfigPath(item.path), message: item.message })),
  };
}
