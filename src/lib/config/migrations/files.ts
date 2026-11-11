/**
 * Migrating the user's config files on disk (`pnpm config:migrate [--write] [--convert-overlays]`). Only the user directory
 * and the profile directory are touched: the shipped defaults are released at the code's current version.
 *
 * A plain migration is structural: a whole file stays whole, at the last version before the overlay format. Only a deploy's
 * write step passes `convertOverlays` (in that one place a file changes format), so a process of the previous version never
 * meets a version it does not know.
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { isDeepStrictEqual } from "node:util";

import type { Document } from "yaml";

import { ConfigError } from "../errors";
import { parseConfigDocument, parseConfigText, resetConfigCache, shippedEffective, validateConfigValue } from "../load";
import { applyOverlayEdits } from "../overlay-diff";
import { getConfigDir, getDefaultConfigPath, getUserConfigPath, readShippedText } from "../paths";
import { readUserText } from "../read-user-file";
import { CONFIG_NAMES, isProfileName, type ConfigName } from "../registry";
import { commitConfigFile, sha256 } from "../atomic";
import { withConfigWriteLock } from "../write-lock";
import { restoreFlowPadding, syncNode, withFileLock } from "../write";
import { stringifyConfigYaml } from "../yaml-options";

import { convertLegacy } from "./overlay-convert";
import type { ConfigMigration } from "./types";
import { CONFIG_VERSION_KEY, documentConfigVersion, hasOverlayFormat, isOverlayVersion, migrateConfigDocument, overlayFormatVersion, withoutConfigVersion } from "./version";

export interface FileMigration {
  name: ConfigName;
  /** The user's file. */
  path: string;
  from: number;
  to: number;
  /** The steps that run, oldest first. */
  steps: { from: number; to: number; description: string | null }[];
  /** Per-file meaning changes reported by the steps. */
  notices: readonly string[];
  /** File text now and after the migration (comments kept). */
  before: string;
  after: string;
  /** The file turned from a whole file into an overlay: what happened to its keys (dotted paths, never values). */
  conversion?: ConversionKeys;
}

export interface ConversionKeys {
  /** Equal to the shipped value: they follow the product from now on. */
  dropped: string[];
  /** Different from the shipped value: the user's own. */
  kept: string[];
  /** Not in the file, and the schema's default differs from the shipped value: written out, so the value does not change. */
  filled: string[];
  /** Not in the file, and no value there: `key: !unset`. */
  unset: string[];
}

export interface PlanMigrationOptions {
  /** Also turn whole files into overlays. Without it a file keeps the whole format version; flagged later steps may still update its shape. */
  convertOverlays?: boolean;
}

export interface FileMigrationProblem {
  name: ConfigName;
  path: string;
  /** One line, never file contents. */
  message: string;
}

export interface ConfigMigrationPlan {
  pending: FileMigration[];
  /** Files that cannot be migrated: unreadable, invalid `config_version`, newer than the code, or invalid after migrating. */
  problems: FileMigrationProblem[];
  /** User files already at the code's version. */
  current: { name: ConfigName; path: string; version: number }[];
}

function firstLine(err: unknown): string {
  if (err instanceof ConfigError) {
    const issue = err.issues[0];
    return issue ? `${issue.path === "" ? "(root)" : issue.path}: ${issue.message}` : (err.message.split("\n")[0] ?? err.kind);
  }
  return err instanceof Error ? err.message : String(err);
}

const YAML_TEXT_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

function writeDocument(before: string, doc: Document): string {
  return restoreFlowPadding(before, stringifyConfigYaml(doc, YAML_TEXT_OPTIONS));
}

/**
 * A whole file (migrated) as an overlay: only the keys `convertLegacy` keeps stay in the document, with their comments, and
 * the check is the one that matters: the new text, merged over the shipped file, gives exactly what the old text gave.
 */
function convertDocument(name: ConfigName, before: string, doc: Document, file: string): { after: string; keys: ConversionKeys; to: number; applied: readonly ConfigMigration[]; notices: readonly string[] } {
  const shippedText = readShippedText(name);
  const shippedFile = getDefaultConfigPath(name) ?? file;
  if (shippedText === null) throw new ConfigError({ configName: name, filePath: shippedFile, kind: "missing", layer: "shipped" });
  const legacyRaw = withoutConfigVersion(doc.toJS());
  const legacyValue = validateConfigValue(name, legacyRaw, file);
  const shipped = shippedEffective(name, shippedText, shippedFile).value;
  const { edits, dropped, kept, filled, unset } = convertLegacy(name, { shipped, legacy: legacyRaw, filePath: file });
  const overlay = applyOverlayEdits({}, edits) as Record<string, unknown>;
  const to = overlayFormatVersion(name) as number;
  doc.contents = syncNode(doc, doc.contents, { [CONFIG_VERSION_KEY]: to, ...overlay }, { omitNewEmpty: false }) as Document["contents"];
  doc.commentBefore = ` Your changes to the shipped file: only the keys written here override it; everything else follows the product.\n Remove a shipped key with \`key: !unset\`. See docs/configuration.md.`;
  const migration = migrateConfigDocument(name, doc, file);
  const after = writeDocument(before, doc);
  if (!isDeepStrictEqual(parseConfigText(name, after, file), legacyValue)) throw new Error("the converted file would give a different value");
  return { after, keys: { dropped, kept, filled, unset }, to: migration.to, applied: migration.applied, notices: migration.notices };
}

/** Look at every config file in the user and profile directories and work out what `--write` would change. Reads only. */
export function planConfigMigrations(names: readonly ConfigName[] = CONFIG_NAMES, options: PlanMigrationOptions = {}): ConfigMigrationPlan {
  const plan: ConfigMigrationPlan = { pending: [], problems: [], current: [] };
  for (const name of names) {
    const file = getUserConfigPath(name);
    let before: string;
    try {
      before = readUserText(file);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") continue; // read from the defaults: nothing of the user's to migrate
      plan.problems.push({ name, path: file, message: firstLine(err) });
      continue;
    }
    try {
      const doc = parseConfigDocument(name, before, file);
      const result = migrateConfigDocument(name, doc, file);
      const steps = result.applied.map((step) => ({ from: step.from, to: step.to, description: step.description ?? null }));
      if (options.convertOverlays && hasOverlayFormat(name) && !isOverlayVersion(name, documentConfigVersion(doc))) {
        const converted = convertDocument(name, before, doc, file);
        const overlayVersion = overlayFormatVersion(name) as number;
        steps.splice(0, steps.length, ...result.applied.filter((step) => !step.wholeFiles).map((step) => ({ from: step.from, to: step.to, description: step.description ?? null })));
        steps.push({ from: result.to, to: overlayVersion, description: "overlay format" });
        steps.push(...converted.applied.map((step) => ({ from: step.from, to: step.to, description: step.description ?? null })));
        plan.pending.push({ name, path: file, from: result.from, to: converted.to, steps, before, after: converted.after, conversion: converted.keys, notices: [...result.notices, ...converted.notices] });
        continue;
      }
      if (result.applied.length === 0) {
        plan.current.push({ name, path: file, version: result.from });
        continue;
      }
      const after = writeDocument(before, doc);
      parseConfigText(name, after, file);
      plan.pending.push({ name, path: file, from: result.from, to: result.to, steps, before, after, notices: result.notices });
    } catch (err) {
      plan.problems.push({ name, path: file, message: firstLine(err) });
    }
  }
  return plan;
}

/** `<user config dir>/.backup/<timestamp>` for a moment (UTC, file-name safe: 2026-10-09T15-30-12Z). */
export function configBackupDir(now: Date): string {
  return path.join(getConfigDir(), ".backup", `${now.toISOString().slice(0, 19).replace(/:/g, "-")}Z`);
}

export interface AppliedConfigMigrations {
  /** Where the originals were copied; null when there was nothing to write. */
  backupDir: string | null;
  written: string[];
  /** The record of a conversion (`conversion-<time>.json` in the user directory: keys, never values); null when none ran. */
  conversionRecord: string | null;
}

/**
 * Write the pending migrations of a plan, one file at a time and each under the config write lock: plan the file again in
 * the lock (a save may have got in first), copy the original to `<user dir>/.backup/<timestamp>/` (profile files under
 * `profile/`), write a temp file, read it back, compare the base and replace. A file with nothing left to migrate, or that
 * changed between that plan and the rename, is skipped (reported as not written) rather than overwritten. Backups are
 * not pruned here (`pruneConfigBackups`).
 */
export async function applyConfigMigrations(plan: ConfigMigrationPlan, now: Date = new Date(), options: PlanMigrationOptions = {}): Promise<AppliedConfigMigrations> {
  if (plan.pending.length === 0) return { backupDir: null, written: [], conversionRecord: null };
  const backupDir = configBackupDir(now);
  const written: string[] = [];
  const converted: Record<string, ConversionKeys> = {};
  for (const { name, path: file } of plan.pending) {
    const done = await withFileLock(file, () => withConfigWriteLock(async () => {
      const item = planConfigMigrations([name], options).pending[0];
      if (item === undefined) return false;
      const copy = path.join(backupDir, isProfileName(name) ? "profile" : "", path.basename(file));
      await fsp.mkdir(/*turbopackIgnore: true*/ path.dirname(copy), { recursive: true });
      await fsp.writeFile(/*turbopackIgnore: true*/ copy, item.before, { encoding: "utf8", mode: 0o600 });
      try {
        await commitConfigFile(file, item.after, {
          baseSha256: sha256(item.before),
          verify: (content) => void parseConfigText(name, content.toString("utf8"), file),
        });
      } catch (error) {
        if (error instanceof ConfigError && error.kind === "stale") return false;
        throw error;
      }
      if (item.conversion) converted[path.basename(file)] = item.conversion;
      return true;
    }, file));
    if (done) written.push(file);
  }
  resetConfigCache();
  let conversionRecord: string | null = null;
  if (Object.keys(converted).length > 0) {
    conversionRecord = path.join(getConfigDir(), `conversion-${path.basename(backupDir)}.json`);
    const text = `${JSON.stringify({ time: now.toISOString(), backup: path.basename(backupDir), files: converted }, null, 2)}\n`;
    await withConfigWriteLock(() => commitConfigFile(conversionRecord as string, text), conversionRecord);
  }
  return { backupDir: written.length > 0 ? backupDir : null, written, conversionRecord };
}
