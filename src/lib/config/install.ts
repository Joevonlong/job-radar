/**
 * Tell a fresh install from an existing one. The setup wizard and the first-start copy of new config
 * files (`ensureConfigFiles`) share this: a file introduced by an upgrade gets the old behaviour written on an existing
 * install and the shipped default on a fresh one.
 */
import fs from "node:fs";
import path from "node:path";

import { getConfigDir } from "./paths";
import { configRegistry, LAYERED_CONFIG_NAMES } from "./registry";

/** The config files of a directory that count as "configured before" (every layered config file). */
export function installedConfigFiles(dir: string = getConfigDir()): string[] {
  const names = LAYERED_CONFIG_NAMES.map((name) => configRegistry[name].file);
  return names.filter((file) => fs.existsSync(/*turbopackIgnore: true*/ path.join(dir, file)));
}

/** True when the user config directory (or `dir`) already holds config files: an install that ran before. */
export function isExistingInstall(dir: string = getConfigDir()): boolean {
  return installedConfigFiles(dir).length > 0;
}
