/**
 * Apply an example setup from `<defaults dir>/examples/<id>/` to your own config (see src/lib/config/examples.ts).
 *
 *   pnpm config:example                    list the examples
 *   pnpm config:example <id> --dry-run     show which settings would change, write nothing
 *   pnpm config:example <id>               back up the files that change to <user config dir>/.backup/<timestamp>/, then write
 *
 * Only the user config directory is written (never the shipped defaults); comments are kept. The runner and the web app
 * pick the change up like any other edit. Honours JOB_RADAR_DEFAULTS_DIR and JOB_RADAR_CONFIG_DIR.
 * Exit codes: 0 done / listed / preview shown, 1 the example cannot be applied (nothing is written then), 2 bad arguments.
 */
import { parseArgs } from "node:util";

import fs from "node:fs";

import { applyExamplePlan, configBackupDir, ConfigError, ConfigExampleError, displayConfigPath, examplesDir, listExamples, planExample, readExample } from "../src/lib/config";

const USAGE = "Usage: pnpm config:example [<id> [--dry-run]]";

async function main(): Promise<number> {
  let id: string | undefined;
  let dryRun = false;
  try {
    const { values, positionals } = parseArgs({ options: { "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    if (positionals.length > 1) throw new Error("only one example at a time");
    id = positionals[0];
    dryRun = values["dry-run"] ?? false;
  } catch (error) {
    console.error(`config:example: ${error instanceof Error ? error.message : "bad arguments"}`);
    console.error(USAGE);
    return 2;
  }

  try {
    if (id === undefined) {
      const examples = listExamples();
      if (examples.length === 0) {
        console.log(`No examples in ${displayConfigPath(examplesDir())}.`);
        return 0;
      }
      console.log(`Examples in ${displayConfigPath(examplesDir())}:`);
      for (const example of examples) console.log(`  ${example.id.padEnd(28)} ${example.name}: ${example.description}`);
      console.log("\nPreview one with `pnpm config:example <id> --dry-run`; apply it without --dry-run.");
      return 0;
    }

    const example = readExample(id);
    const plan = planExample(example);
    console.log(`${example.name} (${example.id})`);
    for (const change of plan) {
      if (change.changed.length === 0) {
        console.log(`= ${displayConfigPath(change.path)}  (already set)`);
        continue;
      }
      console.log(`~ ${displayConfigPath(change.path)}`);
      for (const key of change.changed) console.log(`    ${key}`);
    }
    if (plan.every((change) => change.changed.length === 0)) {
      console.log("Nothing to change.");
      return 0;
    }
    const now = new Date();
    const backupDir = displayConfigPath(configBackupDir(now));
    for (const change of plan) {
      if (change.replaced.length === 0) continue;
      const file = displayConfigPath(change.path);
      const backup = fs.existsSync(change.path) ? `the current file will be backed up to ${backupDir}` : "you have no copy of this file yet, so only shipped defaults are replaced";
      for (const key of change.replaced) console.log(`\n! Warning: ${file} ${key}: the example replaces this list; its current entries are dropped (${backup}).`);
    }
    if (dryRun) {
      console.log("\nDry run: nothing written. Run again without --dry-run to apply.");
      return 0;
    }
    const applied = await applyExamplePlan(plan, now);
    if (applied.backupDir !== null) console.log(`\nPrevious files backed up to ${displayConfigPath(applied.backupDir)}`);
    console.log(`Written: ${applied.written.map((file) => displayConfigPath(file)).join(", ")}`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigExampleError || error instanceof ConfigError) {
      console.error(`config:example: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main();
