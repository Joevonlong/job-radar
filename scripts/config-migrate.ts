/**
 * Bring the user's config files up to the format this code reads (`config_version`).
 *
 *   pnpm config:migrate            list the pending migrations with a diff preview, change nothing
 *   pnpm config:migrate --write    back up the files that change to <user config dir>/.backup/<timestamp>/, then write
 *   pnpm config:migrate --convert-overlays [--write]  also turn whole files into overlays (preview: keys dropped, kept, filled, unset); a deploy's write step does this
 *   pnpm config:migrate --to-full [--write]  turn overlays back into whole files, for a code rollback (originals archived first)
 *   pnpm config:migrate --restore <time> --accept-loss  put back the files of an earlier backup (current files archived first)
 *   pnpm config:migrate --prune-backups  remove the oldest backups beyond schedule.yaml: config_writes.backups_keep
 *
 * Only the user directory and the profile directory are migrated (the shipped defaults are released at the current
 * version). Comments are kept. Files older than the code are migrated in memory on load anyway; this makes it permanent.
 * Honours JOB_RADAR_CONFIG_DIR / JOB_RADAR_PROFILE_DIR.
 * `--write` goes through the config write lock, so it needs the database; the preview does not.
 * Exit codes: 0 done / nothing to do / preview shown, 1 a file cannot be migrated (newer than the code, invalid; nothing
 * With --write, 2 = another writer held the config write lock for longer than config_writes.lock_wait_seconds.
 * is written then) or the database is needed, 2 bad arguments.
 */
import { parseArgs } from "node:util";

import { createTwoFilesPatch } from "diff";

import { applyConfigMigrations, applyToFull, ConfigError, displayConfigPath, planConfigMigrations, planToFull, pruneConfigBackups, restoreConfigBackup } from "../src/lib/config";
import { getTranslator } from "../src/lib/i18n/node";

/** A refused write as the command's message; anything else stays an error. */
function reportLockProblem(error: unknown): boolean {
  if (!(error instanceof ConfigError) || (error.kind !== "db_unavailable" && error.kind !== "busy")) return false;
  const t = getTranslator("configOps", "cli");
  console.error(error.kind === "busy" ? t("busy", { holder: error.detail ?? "" }) : t("dbRequired"));
  return true;
}

async function main(): Promise<number> {
  let write = false;
  let json = false;
  let prune = false;
  let convertOverlays = false;
  let toFull = false;
  let restore: string | undefined;
  let acceptLoss = false;
  try {
    const { values } = parseArgs({ options: { write: { type: "boolean" }, json: { type: "boolean" }, "prune-backups": { type: "boolean" }, "convert-overlays": { type: "boolean" }, "to-full": { type: "boolean" }, restore: { type: "string" }, "accept-loss": { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true });
    if (values.help) {
      console.log("Usage: pnpm config:migrate [--write | --json | --prune-backups] [--convert-overlays]\n       pnpm config:migrate --to-full [--write]\n       pnpm config:migrate --restore <time> --accept-loss");
      return 0;
    }
    convertOverlays = values["convert-overlays"] ?? false;
    toFull = values["to-full"] ?? false;
    restore = values.restore;
    acceptLoss = values["accept-loss"] ?? false;
    write = values.write ?? false;
    json = values.json ?? false;
    prune = values["prune-backups"] ?? false;
    if ([write, json, prune].filter(Boolean).length > 1) return 2;
    if ([convertOverlays, toFull, restore !== undefined].filter(Boolean).length > 1) return 2;
    if ((toFull || restore !== undefined) && (json || prune)) return 2;
    if (restore !== undefined && write) return 2;
    if (acceptLoss && restore === undefined) return 2;
  } catch (error) {
    console.error(`config:migrate: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }

  if (prune) {
    try {
      const removed = await pruneConfigBackups();
      console.log(removed.length === 0 ? "no backups to remove" : `removed ${removed.length} old backup(s)`);
      return 0;
    } catch (error) {
      if (!reportLockProblem(error)) throw error;
      return 1;
    }
  }
  if (restore !== undefined) {
    if (!acceptLoss) {
      console.error("config:migrate: --restore replaces the current config files with older ones; changes made since are lost. Add --accept-loss");
      return 2;
    }
    try {
      const restored = await restoreConfigBackup(restore);
      for (const file of restored.written) console.log(`✓ ${displayConfigPath(file)}`);
      console.log(`current files archived in ${displayConfigPath(restored.backupDir)}\ndone. Run pnpm config:check`);
      return 0;
    } catch (error) {
      if (reportLockProblem(error)) return error instanceof ConfigError && error.kind === "busy" ? 2 : 1;
      console.error(`config:migrate: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (toFull) {
    const full = planToFull();
    for (const problem of full.problems) console.log(`✗ ${displayConfigPath(problem.path)}: ${problem.message}`);
    if (full.problems.length > 0) {
      console.log(`\n${full.problems.length} file(s) cannot be turned into whole files: fix them first (nothing was written)`);
      return 1;
    }
    if (full.pending.length === 0) {
      console.log("nothing to do: no overlay files");
      return 0;
    }
    for (const item of full.pending) console.log(`~ ${displayConfigPath(item.path)}  config_version ${item.from} -> ${item.to}`);
    if (!write) {
      console.log(`\n${full.pending.length} file(s) to turn into whole files. Nothing written: run pnpm config:migrate --to-full --write`);
      return 0;
    }
    try {
      const applied = await applyToFull(full);
      for (const file of applied.written) console.log(`✓ ${displayConfigPath(file)}`);
      if (applied.backupDir !== null) console.log(`originals backed up in ${displayConfigPath(applied.backupDir)}`);
      const skipped = full.pending.length - applied.written.length;
      if (skipped > 0) console.log(`${skipped} file(s) changed meanwhile and were left alone: run pnpm config:migrate --to-full --write again`);
      return 0;
    } catch (error) {
      if (!reportLockProblem(error)) throw error;
      return error instanceof ConfigError && error.kind === "busy" ? 2 : 1;
    }
  }
  const plan = planConfigMigrations(undefined, { convertOverlays });
  if (json) {
    console.log(JSON.stringify({ pending: plan.pending.length, problems: plan.problems.length }));
    return plan.problems.length > 0 ? 1 : 0;
  }
  for (const problem of plan.problems) console.log(`✗ ${displayConfigPath(problem.path)}: ${problem.message}`);
  if (plan.problems.length > 0) {
    console.log(`\n${plan.problems.length} file(s) cannot be migrated: fix them first (nothing was written)`);
    return 1;
  }
  if (plan.pending.length === 0) {
    console.log(`nothing to migrate: ${plan.current.length} user file(s) at the current version`);
    return 0;
  }
  for (const item of plan.pending) {
    const shown = displayConfigPath(item.path);
    console.log(`\n~ ${shown}  config_version ${item.from} -> ${item.to}`);
    for (const step of item.steps) console.log(`    ${step.from} -> ${step.to}${step.description ? `: ${step.description}` : ""}`);
    if (item.conversion) {
      for (const [label, keys] of Object.entries(item.conversion)) if (keys.length > 0) console.log(`    ${label} (${keys.length}): ${keys.join(", ")}`);
    }
    if (!write) process.stdout.write(createTwoFilesPatch(shown, shown, item.before, item.after, `config_version ${item.from}`, `config_version ${item.to}`));
  }
  if (!write) {
    console.log(`\n${plan.pending.length} file(s) to migrate. Nothing written: run pnpm config:migrate --write${convertOverlays ? " --convert-overlays" : ""}`);
    return 0;
  }
  let applied: Awaited<ReturnType<typeof applyConfigMigrations>>;
  try {
    applied = await applyConfigMigrations(plan, new Date(), { convertOverlays });
  } catch (error) {
    if (!reportLockProblem(error)) throw error;
    return error instanceof ConfigError && error.kind === "busy" ? 2 : 1;
  }
  for (const file of applied.written) console.log(`✓ ${displayConfigPath(file)}`);
  if (applied.backupDir !== null) console.log(`originals backed up in ${displayConfigPath(applied.backupDir)}`);
  if (applied.conversionRecord !== null) console.log(`conversion record in ${displayConfigPath(applied.conversionRecord)}`);
  const skipped = plan.pending.length - applied.written.length;
  if (skipped > 0) console.log(`${skipped} file(s) changed while migrating and were left alone: run pnpm config:migrate again`);
  console.log("done. Run pnpm config:check");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`config:migrate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
