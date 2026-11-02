/**
 * Create the user config directory and copy what is missing into it.
 *
 *   pnpm config:init [--from <dir>]
 *   pnpm config:init --env-only
 *
 * Copies every `user` config file (schedule, search, sources, ai, notify, …) that the user directory lacks from the
 * defaults directory, and the profile templates into the profile directory. Never overwrites a file: safe to run again.
 * `--from <dir>` copies from that directory instead (the one-time switch-over of an install that kept its settings in
 * config/: `pnpm config:init --from config`), and then also copies the `shipped` files (models, pipeline) whose content
 * differs from the shipped default, so no change is lost; those become overrides (`pnpm config:check` lists them).
 *
 * The setup state and the language file stay out of it unless --from is given: the wizard writes those. Files go through
 * the config write lock, so this needs the database; without it the `.env` part below is still done, the command prints
 * what to do and exits 1, and missing files read the shipped defaults meanwhile.
 *
 * On a new install (compose.yaml present, no database volume yet, no POSTGRES_PASSWORD in .env) it also writes a random POSTGRES_PASSWORD to
 * .env; an existing database or a password you set is never touched. `--env-only` does only this part (a deploy's first
 * step, before the database exists).
 *
 * Honours JOB_RADAR_DEFAULTS_DIR, JOB_RADAR_CONFIG_DIR and JOB_RADAR_PROFILE_DIR. A relative --from resolves against
 * the working directory. Exit codes: 0 done (or nothing to do), 1 a copy failed or the database is needed, 2 bad arguments.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, displayConfigPath, ensureConfigFiles, ensureProfileFiles, getAppRoot, getConfigDir, getDefaultsDir, getProfileDir } from "../src/lib/config";
import { getTranslator } from "../src/lib/i18n/node";
import { ensureDbPassword } from "../src/lib/ops/db-password";

/** A new install's own database password. Returns the number of files created. */
async function ensureEnvFile(): Promise<number> {
  if (!fs.existsSync(path.join(getAppRoot(), "compose.yaml"))) return 0;
  try {
    if ((await ensureDbPassword({ envFile: path.join(getAppRoot(), ".env") })) === "generated") {
      console.log("+ .env  (POSTGRES_PASSWORD: a random database password for this new install; the value is not shown)");
      return 1;
    }
  } catch (error) {
    console.log(`! .env: could not write a database password (${error instanceof Error ? error.name : "error"}); set POSTGRES_PASSWORD in .env yourself before the first start`);
  }
  return 0;
}

/** A refused write as the command's message; anything else stays an error. */
function reportLockProblem(error: unknown): boolean {
  if (!(error instanceof ConfigError) || (error.kind !== "db_unavailable" && error.kind !== "busy")) return false;
  const t = getTranslator("configOps", "cli");
  console.error(error.kind === "busy" ? t("busy", { holder: error.detail ?? "" }) : t("dbRequired"));
  return true;
}

async function main(): Promise<number> {
  let from: string | undefined;
  let envOnly = false;
  try {
    const { values } = parseArgs({ options: { from: { type: "string" }, "env-only": { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true });
    if (values.help) {
      console.log("Usage: pnpm config:init [--from <dir> | --env-only]");
      return 0;
    }
    envOnly = values["env-only"] ?? false;
    if (envOnly && values.from !== undefined) {
      console.error("config:init: --env-only and --from cannot be combined");
      return 2;
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
  if (envOnly) {
    const created = await ensureEnvFile();
    console.log(created === 0 ? "nothing to do: .env is in place" : ".env created");
    return 0;
  }
  console.log(`defaults: ${displayConfigPath(getDefaultsDir())}`);
  console.log(`user:     ${displayConfigPath(getConfigDir())}`);
  console.log(`profile:  ${displayConfigPath(getProfileDir())}`);
  if (from !== undefined) console.log(`from:     ${displayConfigPath(from)}`);

  let created = 0;
  let refused = false;
  try {
    for (const result of await ensureConfigFiles(from === undefined ? {} : { from })) {
      if (result.created) {
        created += 1;
        if (result.reason === "backfill") {
          console.log(`+ ${displayConfigPath(result.path)}  (restored archive from before this file existed: written with the settings it used)`);
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
  } catch (error) {
    if (!reportLockProblem(error)) throw error;
    refused = true;
  }
  // A new install gets its own database password instead of the well-known default (never for an existing database).
  if (from === undefined) created += await ensureEnvFile();
  if (refused) return 1;
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
