/**
 * The state of the two config layers, for the doctor (`config.layers`) and `pnpm config:check`. Reads only.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";

import { fileLacksVersion, parseConfigDocument, readConfigLayers, shippedEffective } from "./load";
import { planConfigMigrations } from "./migrations/files";
import { documentConfigVersion, hasOverlayFormat, isOverlayVersion, migrateConfigDocument, withoutConfigVersion } from "./migrations/version";
import { countOverlayEntries, overlayEntries, type OverlayCounts, type OverlayEntry } from "./overlay-report";
import { configLayer, displayConfigPath, getConfigDir, getDefaultConfigPath, getDefaultsDir, getUserConfigPath } from "./paths";
import { configRegistry, LAYERED_CONFIG_NAMES, USER_CONFIG_NAMES, type ConfigName } from "./registry";

/** What one user file holds against the shipped file (`format` says whether it is an overlay at all). */
export interface ConfigFileOverlay extends OverlayCounts {
  name: ConfigName;
  /** For people. */
  file: string;
  /** `overlay`: laid over the shipped file; `whole`: a whole file (no `config_version`, or not converted yet); `unreadable`: cannot be parsed or migrated (the other checks say why). */
  format: "overlay" | "whole" | "unreadable";
  entries: OverlayEntry[];
}

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
  /** User files without `config_version`: read as whole files, so keys they lack take the schema's defaults. File names. */
  missingVersion: string[];
  /** User files older than the code (migrated in memory on every load). */
  pendingMigrations: { file: string; from: number; to: number }[];
  /** Per user file that exists and has the overlay format available: its overrides, unsets and pins (reports only). */
  overlays: ConfigFileOverlay[];
  /** User files that cannot be migrated: newer than the code (a downgrade) or an invalid `config_version`. */
  problems: { file: string; message: string }[];
}

const NO_COUNTS: OverlayCounts = { overrides: 0, unsets: 0, pins: 0, invalidUnsets: 0 };

/** The overlay of every user file that has one, read once each; nothing is written. models.yaml has its own by-id overlay. */
export function inspectOverlayFiles(names: readonly ConfigName[] = LAYERED_CONFIG_NAMES): ConfigFileOverlay[] {
  const out: ConfigFileOverlay[] = [];
  for (const name of names) {
    if (!hasOverlayFormat(name)) continue;
    const userPath = getUserConfigPath(name);
    const file = displayConfigPath(userPath);
    try {
      const layers = readConfigLayers(name);
      if (layers.overlay === null) continue;
      const doc = parseConfigDocument(name, layers.overlay, userPath);
      if (!isOverlayVersion(name, documentConfigVersion(doc))) {
        out.push({ name, file, format: "whole", ...NO_COUNTS, entries: [] });
        continue;
      }
      migrateConfigDocument(name, doc, userPath);
      const shippedPath = getDefaultConfigPath(name);
      const shipped = layers.shipped !== null && shippedPath !== null ? shippedEffective(name, layers.shipped, shippedPath).value : undefined;
      const entries = overlayEntries(name, shipped, withoutConfigVersion(doc.toJS()));
      out.push({ name, file, format: "overlay", ...countOverlayEntries(entries), entries });
    } catch {
      out.push({ name, file, format: "unreadable", ...NO_COUNTS, entries: [] });
    }
  }
  return out;
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
    missingVersion: LAYERED_CONFIG_NAMES.filter(fileLacksVersion).map((name) => configRegistry[name].file),
    overlays: inspectOverlayFiles(),
    pendingMigrations: plan.pending.map((item) => ({ file: displayConfigPath(item.path), from: item.from, to: item.to })),
    problems: plan.problems.map((item) => ({ file: displayConfigPath(item.path), message: item.message })),
  };
}
