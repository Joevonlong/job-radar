/**
 * Prepare the disposable database the Playwright web server runs against.
 *
 *   E2E_ADMIN_DATABASE_URL=<server where the role may CREATE DATABASE> DATABASE_URL=<e2e database url> tsx scripts/e2e-prepare.ts [--fresh]
 *
 * Creates the target database when it does not exist, applies the migrations and loads the
 * dashboard seed (idempotent: it replaces what a previous run created, so every e2e run starts from
 * the same rows). Never touches any other database. Called from playwright.config.ts before the
 * web server starts. The run's config directory gets the setup marked complete, so no page opens the wizard.
 *
 * `--fresh` (playwright.setup.config.ts): a brand-new install for the setup wizard: the run's config and profile
 * directories are emptied (the web fills them on start, as on a first `docker compose up`), the database is dropped,
 * recreated and only migrated (no seed).
 */
import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { ensureConfigFiles, getAppRoot, getConfigDir, getDefaultsDir, getProfileDir, loadConfig, parseConfigText } from "../src/lib/config";
import { completeSetup } from "../src/lib/setup/state";
import { createConnection } from "../src/lib/db/client";
import { runMigrations } from "../src/lib/db/migrate";
import { seedDatabase } from "../src/lib/db/seed";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`e2e-prepare: ${name} is not set`);
    process.exit(2);
  }
  return value;
}

const fresh = process.argv.includes("--fresh");

// The database checks come first: nothing on disk or in a database is touched for a name that is refused.
const adminUrl = required("E2E_ADMIN_DATABASE_URL");
const targetUrl = new URL(required("DATABASE_URL"));
const dbName = decodeURIComponent(targetUrl.pathname.slice(1));
if (!/^[a-z0-9_]+$/.test(dbName)) {
  console.error("e2e-prepare: database name must match [a-z0-9_]+");
  process.exit(2);
}

// Truncating, seeding and dropping are only ever done to an e2e database, fresh or not: a name that does not start with
// jobradar_e2e (for instance a typo in E2E_DB_NAME that lands on a real database) is refused before anything is touched.
if (!dbName.startsWith("jobradar_e2e")) {
  console.error(`e2e-prepare${fresh ? " --fresh" : ""}: the database name must start with jobradar_e2e (got "${dbName}")`);
  process.exit(2);
}

// The settings page writes the user config directory: the run has its own, refilled from the defaults directory it
// runs with (playwright.config.ts points JOB_RADAR_DEFAULTS_DIR at the test fixture snapshot, playwright.setup.config.ts at the
// shipped config/). Never the real user directory.
const configDir = getConfigDir();
const realUserDirs = [path.join(getAppRoot(), "data", "config"), path.join(getAppRoot(), "config"), getDefaultsDir()];
const realProfileDirs = [path.join(getAppRoot(), "data", "profile")];
if (fresh) {
  if (!process.env.JOB_RADAR_CONFIG_DIR || realUserDirs.includes(configDir) || !process.env.JOB_RADAR_PROFILE_DIR || realProfileDirs.includes(getProfileDir())) {
    console.error("e2e-prepare --fresh: JOB_RADAR_CONFIG_DIR and JOB_RADAR_PROFILE_DIR must point at throw-away directories");
    process.exit(2);
  }
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(getProfileDir(), { recursive: true, force: true });
} else if (process.env.JOB_RADAR_CONFIG_DIR && !realUserDirs.includes(configDir)) {
  fs.rmSync(configDir, { recursive: true, force: true });
  await ensureConfigFiles();
  // The main suite runs on a configured install: the setup is complete, so no page redirects to the wizard
  if (!(await completeSetup("cli")).ok) {
    console.error("e2e-prepare: could not mark the setup complete");
    process.exit(2);
  }
  // The shipped breakdown.yaml is off; the e2e copy (never the shipped file) turns it on so the card can be driven
  const breakdownFile = path.join(configDir, "breakdown.yaml");
  const breakdownText = fs.readFileSync(breakdownFile, "utf8").replace(/^enabled: (false|true)$/m, "enabled: true");
  parseConfigText("breakdown", breakdownText);
  fs.writeFileSync(breakdownFile, breakdownText);
  // The shipped salary lookup is off; the e2e copy turns it on (the e2e runner answers the requests, no AI is called)
  const salaryFile = path.join(configDir, "salary.yaml");
  const salaryText = fs.readFileSync(salaryFile, "utf8")
    .replace(/^(lookup:\n(?:[ \t]*#.*\n)*  enabled: )false$/m, "$1true")
    // the seeded jobs are few: groups of two already compare, so the job page shows a benchmark
    .replace(/^  min_sample: \d+$/m, "  min_sample: 2");
  parseConfigText("salary", salaryText);
  fs.writeFileSync(salaryFile, salaryText);
}

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  if (fresh) await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  const rows = await admin`select 1 from pg_database where datname = ${dbName}`;
  if (rows.length === 0) await admin.unsafe(`create database "${dbName}"`);
} finally {
  await admin.end({ timeout: 5 });
}
await runMigrations({ url: targetUrl.toString() });
if (fresh) {
  console.log(`e2e-prepare: database "${dbName}" is empty and migrated (fresh install)`);
  process.exit(0);
}

const connection = createConnection(targetUrl.toString(), { max: 1 });
try {
  await connection.sql`truncate table control_requests, runtime_state`;
  await seedDatabase(connection.db, { timezone: loadConfig("schedule").timezone });
} finally {
  await connection.sql.end({ timeout: 5 });
}
console.log(`e2e-prepare: database "${dbName}" is ready`);
