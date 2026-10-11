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
import { atomicWrite, restoreFlowPadding } from "../write";

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
 * Write the pending migrations of a plan: first copy every file that will change to `<user dir>/.backup/<timestamp>/`
 * (profile files under `profile/`), then replace each file atomically. Files changed since the plan are skipped
 * (reported as not written) rather than overwritten.
 */
export async function applyConfigMigrations(plan: ConfigMigrationPlan, now: Date = new Date()): Promise<AppliedConfigMigrations> {
  if (plan.pending.length === 0) return { backupDir: null, written: [] };
  const backupDir = configBackupDir(now);
  const fresh = plan.pending.filter((item) => fs.readFileSync(/*turbopackIgnore: true*/ item.path, "utf8") === item.before);
  for (const item of fresh) {
    const target = path.join(backupDir, isProfileName(item.name) ? "profile" : "", path.basename(item.path));
    await fsp.mkdir(/*turbopackIgnore: true*/ path.dirname(target), { recursive: true });
    await fsp.writeFile(/*turbopackIgnore: true*/ target, item.before, { encoding: "utf8", mode: 0o600 });
  }
  const written: string[] = [];
  for (const item of fresh) {
    await atomicWrite(item.path, item.after);
    written.push(item.path);
  }
  resetConfigCache();
  return { backupDir: fresh.length > 0 ? backupDir : null, written };
}
