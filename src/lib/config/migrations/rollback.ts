/**
 * The way back from overlays (`pnpm config:migrate --to-full`, `--restore`).
 *
 * - `--to-full`: before a code rollback to a version that reads whole files only, every overlay becomes a whole file with the
 *   same effective value, one file at a time under the config write lock, after archiving the original.
 * - `--restore <time>`: put back the files of an earlier backup. Changes made since are lost, so it takes `--accept-loss`
 *   (`scripts/config-migrate.ts`); the current files are archived first.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { commitConfigFile, sha256 } from "../atomic";
import { ConfigError } from "../errors";
import { parseConfigDocument, parseConfigText, resetConfigCache, shippedEffective } from "../load";
import { getConfigDir, getDefaultConfigPath, getProfileDir, getUserConfigPath, readShippedText } from "../paths";
import { readUserText } from "../read-user-file";
import { CONFIG_NAMES, configRegistry, isProfileName, LAYERED_CONFIG_NAMES, type ConfigName } from "../registry";
import { toFullText } from "../to-full";
import { withFileLock } from "../write";
import { withConfigWriteLock } from "../write-lock";
import { parseConfigYamlDocument } from "../yaml-options";

import { configBackupDir, type FileMigrationProblem } from "./files";
import { documentConfigVersion, hasOverlayFormat, isOverlayVersion, legacyFormatVersion } from "./version";

export interface ToFullItem {
  name: ConfigName;
  path: string;
  from: number;
  to: number;
  before: string;
  after: string;
}

export interface ToFullPlan {
  pending: ToFullItem[];
  problems: FileMigrationProblem[];
}

function planOne(name: ConfigName): ToFullItem | null {
  const file = getUserConfigPath(name);
  if (!fs.existsSync(/*turbopackIgnore: true*/ file)) return null;
  const before = readUserText(file);
  const doc = parseConfigDocument(name, before, file);
  const version = documentConfigVersion(doc);
  if (!isOverlayVersion(name, version) || version === null) return null;
  const shippedFile = getDefaultConfigPath(name) ?? file;
  const shippedText = readShippedText(name);
  if (shippedText === null) throw new ConfigError({ configName: name, filePath: shippedFile, kind: "missing", layer: "shipped" });
  const effective = parseConfigText(name, before, file);
  const after = toFullText(name, shippedEffective(name, shippedText, shippedFile).doc, doc);
  if (!isDeepStrictEqual(parseConfigText(name, after, file), effective)) throw new Error("the whole file would give a different value");
  return { name, path: file, from: version, to: legacyFormatVersion(name), before, after };
}

/** What `--to-full --write` would change. Reads only. */
export function planToFull(names: readonly ConfigName[] = LAYERED_CONFIG_NAMES): ToFullPlan {
  const plan: ToFullPlan = { pending: [], problems: [] };
  for (const name of names) {
    if (!hasOverlayFormat(name)) continue;
    try {
      const item = planOne(name);
      if (item !== null) plan.pending.push(item);
    } catch (error) {
      const message = error instanceof ConfigError ? (error.issues[0]?.message ?? error.message.split("\n")[0] ?? error.kind) : error instanceof Error ? error.message : String(error);
      plan.problems.push({ name, path: getUserConfigPath(name), message });
    }
  }
  return plan;
}

export interface AppliedToFull {
  backupDir: string | null;
  written: string[];
}

/** Turn the planned overlays into whole files; a file that changed since is planned again in the lock or left alone. */
export async function applyToFull(plan: ToFullPlan, now: Date = new Date()): Promise<AppliedToFull> {
  if (plan.pending.length === 0) return { backupDir: null, written: [] };
  const backupDir = configBackupDir(now);
  const written: string[] = [];
  for (const { name, path: file } of plan.pending) {
    const done = await withFileLock(file, () => withConfigWriteLock(async () => {
      const item = planOne(name);
      if (item === null) return false;
      const copy = path.join(backupDir, path.basename(file));
      await fsp.mkdir(/*turbopackIgnore: true*/ backupDir, { recursive: true });
      await fsp.writeFile(/*turbopackIgnore: true*/ copy, item.before, { encoding: "utf8", mode: 0o600 });
      try {
        await commitConfigFile(file, item.after, {
          baseSha256: sha256(item.before),
          verify: (content) => {
            const doc = parseConfigYamlDocument(content.toString("utf8"));
            if (doc.errors.length > 0) throw doc.errors[0];
          },
        });
      } catch (error) {
        if (error instanceof ConfigError && error.kind === "stale") return false;
        throw error;
      }
      return true;
    }, file));
    if (done) written.push(file);
  }
  resetConfigCache();
  return { backupDir: written.length > 0 ? backupDir : null, written };
}

const BACKUP_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

function targetOf(name: ConfigName): { relative: string; target: string } {
  const file = configRegistry[name].file;
  return isProfileName(name) ? { relative: path.join("profile", file), target: path.join(getProfileDir(), file) } : { relative: file, target: getUserConfigPath(name) };
}

/**
 * Put back the config files of `.backup/<time>/`. Each file: under the locks, the current text is archived in a new backup
 * of its own, then replaced. Files that backup does not hold are left as they are.
 */
export async function restoreConfigBackup(time: string, now: Date = new Date()): Promise<{ backupDir: string; written: string[] }> {
  if (!BACKUP_TIME.test(time)) throw new Error(`not a backup time: ${time} (expected 2026-10-09T15-30-12Z)`);
  const source = path.join(getConfigDir(), ".backup", time);
  if (!fs.existsSync(/*turbopackIgnore: true*/ source)) throw new Error(`no backup at that time: ${time}`);
  const backupDir = configBackupDir(now);
  if (path.resolve(backupDir) === path.resolve(source)) throw new Error("the backup was made this second: try again in a moment");
  const written: string[] = [];
  for (const name of CONFIG_NAMES) {
    const { relative, target } = targetOf(name);
    const from = path.join(source, relative);
    if (!fs.existsSync(/*turbopackIgnore: true*/ from)) continue;
    await withFileLock(target, () => withConfigWriteLock(async () => {
      const text = readUserText(from);
      if (fs.existsSync(/*turbopackIgnore: true*/ target)) {
        const copy = path.join(backupDir, relative);
        await fsp.mkdir(/*turbopackIgnore: true*/ path.dirname(copy), { recursive: true });
        await fsp.writeFile(/*turbopackIgnore: true*/ copy, readUserText(target), { encoding: "utf8", mode: 0o600 });
      }
      await commitConfigFile(target, text);
    }, target));
    written.push(target);
  }
  resetConfigCache();
  return { backupDir, written };
}
