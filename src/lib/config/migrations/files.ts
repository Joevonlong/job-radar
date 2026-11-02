/**
 * Migrating the user's config files on disk (`pnpm config:migrate [--write]`). Only the user directory and the
 * profile directory are touched: the shipped defaults are released at the code's current version.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "../errors";
import { parseConfigDocument, resetConfigCache, validateConfigValue } from "../load";
import { getConfigDir, getUserConfigPath } from "../paths";
import { CONFIG_NAMES, isProfileName, type ConfigName } from "../registry";
import { commitConfigFile, sha256 } from "../atomic";
import { withConfigWriteLock } from "../write-lock";
import { restoreFlowPadding, withFileLock } from "../write";

import { migrateConfigDocument } from "./version";

export interface FileMigration {
  name: ConfigName;
  /** The user's file. */
  path: string;
  from: number;
  to: number;
  /** The steps that run, oldest first. */
  steps: { from: number; to: number; description: string | null }[];
  /** File text now and after the migration (comments kept). */
  before: string;
  after: string;
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

/** Look at every config file in the user and profile directories and work out what `--write` would change. Reads only. */
export function planConfigMigrations(names: readonly ConfigName[] = CONFIG_NAMES): ConfigMigrationPlan {
  const plan: ConfigMigrationPlan = { pending: [], problems: [], current: [] };
  for (const name of names) {
    const file = getUserConfigPath(name);
    let before: string;
    try {
      before = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") continue; // read from the defaults: nothing of the user's to migrate
      plan.problems.push({ name, path: file, message: firstLine(err) });
      continue;
    }
    try {
      const doc = parseConfigDocument(name, before, file);
      const result = migrateConfigDocument(name, doc, file);
      if (result.applied.length === 0) {
        plan.current.push({ name, path: file, version: result.from });
        continue;
      }
      const after = restoreFlowPadding(before, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
      validateConfigValue(name, parseConfigDocument(name, after, file).toJS(), file);
      plan.pending.push({
        name,
        path: file,
        from: result.from,
        to: result.to,
        steps: result.applied.map((step) => ({ from: step.from, to: step.to, description: step.description ?? null })),
        before,
        after,
      });
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
}

/**
 * Write the pending migrations of a plan, one file at a time and each under the config write lock: plan the file again in
 * the lock (a save may have got in first), copy the original to `<user dir>/.backup/<timestamp>/` (profile files under
 * `profile/`), write a temp file, read it back, compare the base and replace. A file with nothing left to migrate, or that
 * changed between that plan and the rename, is skipped (reported as not written) rather than overwritten. Backups are
 * not pruned here (`pruneConfigBackups`).
 */
export async function applyConfigMigrations(plan: ConfigMigrationPlan, now: Date = new Date()): Promise<AppliedConfigMigrations> {
  if (plan.pending.length === 0) return { backupDir: null, written: [] };
  const backupDir = configBackupDir(now);
  const written: string[] = [];
  for (const { name, path: file } of plan.pending) {
    const done = await withFileLock(file, () => withConfigWriteLock(async () => {
      const item = planConfigMigrations([name]).pending[0];
      if (item === undefined) return false;
      const copy = path.join(backupDir, isProfileName(name) ? "profile" : "", path.basename(file));
      await fsp.mkdir(/*turbopackIgnore: true*/ path.dirname(copy), { recursive: true });
      await fsp.writeFile(/*turbopackIgnore: true*/ copy, item.before, { encoding: "utf8", mode: 0o600 });
      try {
        await commitConfigFile(file, item.after, {
          baseSha256: sha256(item.before),
          verify: (content) => void validateConfigValue(name, parseConfigDocument(name, content.toString("utf8"), file).toJS(), file),
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
