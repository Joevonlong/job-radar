/**
 * Server side of the protected keys (`protected-keys.ts`): compares a value about to be written with the file on disk and
 * the shipped default. Used by `writeConfig` / `writeConfigText` (every write) and the advanced editor's validation.
 */
import fs from "node:fs";

import { ConfigError } from "./errors";
import { configSourcePath, parseConfigText, readConfigText } from "./load";
import { getDefaultConfigPath, getUserConfigPath } from "./paths";
import { changedProtectedPaths, protectedEditAllowed, protectedPatterns } from "./protected-keys";
import type { ConfigName } from "./registry";

/** Message of a protected-key issue (the browser translates it). */
export const PROTECTED_KEY_MESSAGE = "protected_key";

function currentValue(name: ConfigName): unknown {
  try {
    return parseConfigText(name, readConfigText(name), configSourcePath(name));
  } catch {
    return null;
  }
}

function shippedValue(name: ConfigName): unknown {
  const file = getDefaultConfigPath(name);
  if (file === null) return null;
  try {
    return parseConfigText(name, fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"), file);
  } catch {
    return null;
  }
}

/**
 * The protected keys `next` would change (each as its key segments); empty when none, when the file has no protected
 * keys, or when `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` is set.
 */
export function protectedChanges(name: ConfigName, next: unknown): string[][] {
  if (protectedPatterns(name).length === 0 || protectedEditAllowed()) return [];
  return changedProtectedPaths(name, next, currentValue(name), shippedValue(name));
}

/** Throws `ConfigError` (kind `protected`, one issue per key) when `next` changes a protected key. */
export function assertProtectedUnchanged(name: ConfigName, next: unknown): void {
  const changed = protectedChanges(name, next);
  if (changed.length === 0) return;
  throw new ConfigError({
    configName: name,
    filePath: getUserConfigPath(name),
    kind: "protected",
    issues: changed.map((segments) => ({ path: segments.join("."), message: PROTECTED_KEY_MESSAGE })),
  });
}
