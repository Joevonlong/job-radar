/**
 * What config writes are waiting, without writing anything.
 *
 *   pnpm config:plan              structural migrations only
 *   pnpm config:plan --deploy     everything a deploy's write step would do (migrations, conversion to overlays, then the files config:init creates)
 *   pnpm config:plan --check      as above, and the exit code says whether anything is left
 *
 * Exit codes: 0 nothing pending (or, without --check, the list was printed), 2 writes are pending (--check) or bad
 * arguments, 1 a file cannot be migrated.
 */
import { parseArgs } from "node:util";

import { DEPLOY_WRITE_PLAN, displayConfigPath, planConfigWrites } from "../src/lib/config";

function main(): number {
  let deploy = false;
  let check = false;
  try {
    const { values } = parseArgs({ options: { deploy: { type: "boolean" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true });
    if (values.help) {
      console.log("Usage: pnpm config:plan [--deploy] [--check]");
      return 0;
    }
    deploy = values.deploy ?? false;
    check = values.check ?? false;
  } catch (error) {
    console.error(`config:plan: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }
  const plan = planConfigWrites(deploy ? DEPLOY_WRITE_PLAN : { convertOverlays: false, init: false });
  for (const problem of plan.problems) console.log(`x ${displayConfigPath(problem.path)}: ${problem.message}`);
  for (const write of plan.writes) {
    if (write.kind === "migrate") console.log(`~ ${displayConfigPath(write.path)}  config_version ${write.from} -> ${write.to}`);
    else if (write.kind === "convert") console.log(`> ${displayConfigPath(write.path)}  to an overlay, config_version ${write.from} -> ${write.to}`);
    else console.log(`+ ${displayConfigPath(write.path)}`);
  }
  if (plan.problems.length > 0) return 1;
  if (plan.writes.length === 0) console.log("no config writes pending");
  return check && plan.writes.length > 0 ? 2 : 0;
}

process.exit(main());
