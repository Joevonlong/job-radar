/**
 * Bring the user's config files up to the format this code reads (`config_version`).
 *
 *   pnpm config:migrate            list the pending migrations with a diff preview, change nothing
 *   pnpm config:migrate --write    back up the files that change to <user config dir>/.backup/<timestamp>/, then write
 *
 * Only the user directory and the profile directory are migrated (the shipped defaults are released at the current
 * version). Comments are kept. Files older than the code are migrated in memory on load anyway; this makes it permanent.
 * Honours JOB_RADAR_CONFIG_DIR / JOB_RADAR_PROFILE_DIR.
 * Exit codes: 0 done / nothing to do / preview shown, 1 a file cannot be migrated (newer than the code, invalid; nothing
 * is written then), 2 bad arguments.
 */
import { parseArgs } from "node:util";

import { createTwoFilesPatch } from "diff";

import { applyConfigMigrations, displayConfigPath, planConfigMigrations } from "../src/lib/config";

async function main(): Promise<number> {
  let write = false;
  let json = false;
  try {
    const { values } = parseArgs({ options: { write: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true });
    if (values.help) {
      console.log("Usage: pnpm config:migrate [--write | --json]");
      return 0;
    }
    write = values.write ?? false;
    json = values.json ?? false;
    if (write && json) return 2;
  } catch (error) {
    console.error(`config:migrate: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }

  const plan = planConfigMigrations();
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
    if (!write) process.stdout.write(createTwoFilesPatch(shown, shown, item.before, item.after, `config_version ${item.from}`, `config_version ${item.to}`));
  }
  if (!write) {
    console.log(`\n${plan.pending.length} file(s) to migrate. Nothing written: run pnpm config:migrate --write`);
    return 0;
  }
  const applied = await applyConfigMigrations(plan);
  for (const file of applied.written) console.log(`✓ ${displayConfigPath(file)}`);
  if (applied.backupDir !== null) console.log(`originals backed up in ${displayConfigPath(applied.backupDir)}`);
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
