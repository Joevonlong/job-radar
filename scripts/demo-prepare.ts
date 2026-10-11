/**
 * Prepare (or remove) the throw-away instance behind the README screenshots (`pnpm demo:shots`).
 *
 *   DEMO_ADMIN_DATABASE_URL=<server where the role may CREATE DATABASE> [DEMO_DB_NAME=jobradar_demo...] \
 *   [DEMO_CONFIG_DIR=<temp dir>] [DEMO_PROFILE_DIR=<temp dir>] tsx scripts/demo-prepare.ts [--drop]
 *
 * In every mode the database name must start with `jobradar_demo` and both directories must lie inside a temp directory
 * (`scripts/demo/checks.ts`); otherwise nothing is touched (exit code 2). `DATABASE_URL` and `JOB_RADAR_*` from the
 * caller are ignored: they are set from the checked values.
 *
 * Prepare: drops and recreates the demo database, applies the migrations and writes the demo data (the fictional seed plus
 * the extra application statuses, `src/lib/db/seed-demo.ts`). The config directory is refilled from the shipped defaults
 * with the setup marked complete and the "AI engineering in Europe" example applied; the profile directory gets the
 * fictional demo profile of `scripts/demo/profile/`.
 * `--drop`: drops the demo database and removes both directories.
 */
import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { DEMO_BASE_URL, DEMO_TIMEZONE, demoInstance, demoNow, type DemoInstance } from "./demo/checks";

const EXAMPLE_ID = "ai-engineering-europe";
const PROFILE_SOURCE = path.resolve(import.meta.dirname, "demo/profile");
const DEFAULTS_DIR = path.resolve(import.meta.dirname, "../config");

function fail(message: string): never {
  console.error(`demo-prepare: ${message}`);
  process.exit(2);
}

const drop = process.argv.includes("--drop");
let instance: DemoInstance;
try {
  instance = demoInstance();
} catch (error) {
  fail(error instanceof Error ? error.message : "invalid settings");
}
const { adminUrl, dbName, databaseUrl: targetUrl, configDir, profileDir } = instance;
// the app's modules (loaded below) read these
process.env.DATABASE_URL = targetUrl;
process.env.JOB_RADAR_CONFIG_DIR = configDir;
process.env.JOB_RADAR_PROFILE_DIR = profileDir;
process.env.JOB_RADAR_DEFAULTS_DIR = DEFAULTS_DIR;

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  if (!drop) await admin.unsafe(`create database "${dbName}"`);
} finally {
  await admin.end({ timeout: 5 });
}
fs.rmSync(configDir, { recursive: true, force: true });
fs.rmSync(profileDir, { recursive: true, force: true });
if (drop) {
  console.log(`demo-prepare: database "${dbName}" dropped, demo directories removed`);
  process.exit(0);
}

// Loaded after the checks: these modules read the directories from the environment.
const { applyExamplePlan, ensureConfigFiles, getConfigDir, parseConfigText, planExample, readExample } = await import("../src/lib/config");
const { completeSetup } = await import("../src/lib/setup/state");
const { createConnection } = await import("../src/lib/db/client");
const { runMigrations } = await import("../src/lib/db/migrate");
const { seedDemoDatabase } = await import("../src/lib/db/seed-demo");

// the profile first: the config layer reads the market from preferences.yaml
fs.mkdirSync(profileDir, { recursive: true });
for (const file of ["me.yaml", "preferences.yaml"]) {
  const text = fs.readFileSync(path.join(PROFILE_SOURCE, file), "utf8");
  parseConfigText(file === "me.yaml" ? "me" : "preferences", text);
  fs.writeFileSync(path.join(profileDir, file), text);
}

await ensureConfigFiles();
if (!(await completeSetup("cli")).ok) fail("could not mark the setup complete");
await applyExamplePlan(planExample(readExample(EXAMPLE_ID)));

/** Rewrite one config file of the demo directory, checked against its schema. */
function patch(name: Parameters<typeof parseConfigText>[0], file: string, edit: (text: string) => string): void {
  const filePath = path.join(getConfigDir(), file);
  const before = fs.readFileSync(filePath, "utf8");
  const after = edit(before);
  if (after === before) fail(`${file}: the demo setting could not be applied`);
  parseConfigText(name, after);
  fs.writeFileSync(filePath, after);
}
// the demo person's city (the example leaves the cities to the user)
patch("search", "search.yaml", (text) => text.replace(/^locations:\n(?:  - .*\n)+/m, "locations:\n  - Berlin\n"));
// the paid LinkedIn source needs an API key the demo does not have (src/lib/db/seed-demo.ts DEMO_DISABLED_CHANNELS)
patch("channels", "sources.yaml", (text) => text.replace(/^(  brightdata:\n    enabled: )true$/m, "$1false"));
patch("schedule", "schedule.yaml", (text) => text.replace(/^timezone: .*$/m, `timezone: ${DEMO_TIMEZONE}`));
patch("notify", "notify.yaml", (text) => text.replace(/^public_base_url: .*$/m, `public_base_url: ${DEMO_BASE_URL}`));
// every application status visible on the board (the shipped default already hides none; the demo does not depend on it)
const uiFile = path.join(getConfigDir(), "ui.yaml");
const uiText = fs.readFileSync(uiFile, "utf8").replace(/^(applications:\n(?:[ \t]*#.*\n)*  hidden_statuses: ).*$/m, "$1[]");
parseConfigText("ui", uiText);
fs.writeFileSync(uiFile, uiText);

const connection = createConnection(targetUrl, { max: 1 });
try {
  await runMigrations({ url: targetUrl });
  const result = await seedDemoDatabase(connection.db, { now: demoNow(), timezone: DEMO_TIMEZONE });
  console.log(`demo-prepare: database "${dbName}" ready (${result.jobs} jobs, ${result.applications} applications)`);
} finally {
  await connection.sql.end({ timeout: 5 });
}
