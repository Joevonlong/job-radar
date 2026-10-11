/**
 * Create the user config directory and copy what is missing into it.
 *
 *   pnpm config:init [--from <dir>]
 *
 * Copies every `user` config file (schedule, search, sources, ai, notify, …) that the user directory lacks from the
 * defaults directory, and the profile templates into the profile directory. Never overwrites a file: safe to run again.
 * `--from <dir>` copies from that directory instead (the one-time switch-over of an install that kept its settings in
 * config/: `pnpm config:init --from config`), and then also copies the `shipped` files (models, pipeline) whose content
 * differs from the shipped default, so no change is lost; those become overrides (`pnpm config:check` lists them).
 *
 * On a new install (compose.yaml present, no database volume yet, no POSTGRES_PASSWORD in .env) it also writes a random POSTGRES_PASSWORD to
 * .env; an existing database or a password you set is never touched.
 *
 * Honours JOB_RADAR_DEFAULTS_DIR, JOB_RADAR_CONFIG_DIR and JOB_RADAR_PROFILE_DIR. A relative --from resolves against
 * the working directory. Exit codes: 0 done (or nothing to do), 1 a copy failed, 2 bad arguments.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { displayConfigPath, ensureConfigFiles, ensureProfileFiles, getAppRoot, getConfigDir, getDefaultsDir, getProfileDir } from "../src/lib/config";
import { ensureDbPassword } from "../src/lib/ops/db-password";

async function main(): Promise<number> {
  let from: string | undefined;
  try {
    const { values } = parseArgs({ options: { from: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true });
    if (values.help) {
      console.log("Usage: pnpm config:init [--from <dir>]");
      return 0;
    }
    from = values.from === undefined ? undefined : path.resolve(values.from);
  } catch (error) {
    console.error(`config:init: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }
  if (from !== undefined && !fs.statSync(from, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`config:init: --from ${from} is not a directory`);
    return 2;
  }
  console.log(`defaults: ${displayConfigPath(getDefaultsDir())}`);
  console.log(`user:     ${displayConfigPath(getConfigDir())}`);
  console.log(`profile:  ${displayConfigPath(getProfileDir())}`);
  if (from !== undefined) console.log(`from:     ${displayConfigPath(from)}`);

  const results = await ensureConfigFiles(from === undefined ? {} : { from });
  let created = 0;
  for (const result of results) {
    if (result.created) {
      created += 1;
      if (result.reason === "upgrade") {
        console.log(`+ ${displayConfigPath(result.path)}  (new in this version; written with the settings this install used so far)`);
        continue;
      }
      if (result.reason === "existing_install") {
        console.log(`+ ${displayConfigPath(result.path)}  (existing install: setup marked complete, the setup wizard does not open)`);
        continue;
      }
      const note = result.reason === "override" ? "  (differs from the shipped default: now an override)" : "";
      console.log(`+ ${displayConfigPath(result.path)}  <- ${displayConfigPath(result.source ?? "")}${note}`);
    } else if (result.missing) {
      console.log(`! ${result.name}: not in the user directory and no copy to start from (pnpm config:check will report it)`);
    }
  }
  for (const profile of await ensureProfileFiles()) {
    if (profile.created) {
      created += 1;
      console.log(`+ ${displayConfigPath(profile.path)}  (from the template)`);
    }
  }
  // A new install gets its own database password instead of the well-known default (never for an existing database).
  if (from === undefined && fs.existsSync(path.join(getAppRoot(), "compose.yaml"))) {
    try {
      if ((await ensureDbPassword({ envFile: path.join(getAppRoot(), ".env") })) === "generated") {
        console.log("+ .env  (POSTGRES_PASSWORD: a random database password for this new install; the value is not shown)");
        created += 1;
      }
    } catch (error) {
      console.log(`! .env: could not write a database password (${error instanceof Error ? error.name : "error"}); set POSTGRES_PASSWORD in .env yourself before the first start`);
    }
  }
  console.log(created === 0 ? "nothing to do: every file is in place" : `${created} file(s) created; existing files were not touched`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`config:init: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
