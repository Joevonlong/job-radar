import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";
import { z } from "zod";

import { planProjects, specFiltersFromArgv } from "./e2e/projects";
import { requireTestAdminDatabaseUrl } from "./scripts/test-database";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// With E2E_PORT set explicitly, the database and the two directories default to names derived from it, so runs on
// different ports (e.g. one per git worktree) never share state. Without it the fixed names below apply.
const PORT_SUFFIX = process.env.E2E_PORT ? `_${PORT}` : "";

// The web server runs against a disposable database and profile directory, never the real ones.
// `scripts/e2e-prepare.ts` runs before the server starts: it creates the database when missing,
// applies the migrations and loads the dashboard seed (`pnpm db:seed` data), so every run starts from
// the same rows. Needs a Postgres server where the role may create databases: E2E_ADMIN_DATABASE_URL or DATABASE_URL
// (there is no default: a run never falls back to the database of a local installation, see scripts/test-database.ts).
// (Playwright re-evaluates this file in every worker, so the values must be deterministic.)
const ADMIN_DATABASE_URL = requireTestAdminDatabaseUrl(process.env, ["E2E_ADMIN_DATABASE_URL", "DATABASE_URL"], "e2e tests");
const E2E_DATABASE_URL = (() => {
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${process.env.E2E_DB_NAME ?? `jobradar_e2e${PORT_SUFFIX}`}`;
  return url.toString();
})();
const E2E_PROFILE_DIR = process.env.E2E_PROFILE_DIR ?? path.join(os.tmpdir(), `job-radar-e2e-profile${PORT_SUFFIX.replace("_", "-")}`);
process.env.E2E_PROFILE_DIR = E2E_PROFILE_DIR;
// The settings page writes the user config directory: the run gets its own (scripts/e2e-prepare.ts refills it from
// the defaults). The defaults are the frozen test fixture, not the repository's config/ (which ships generic defaults).
const E2E_CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? path.join(os.tmpdir(), `job-radar-e2e-config${PORT_SUFFIX.replace("_", "-")}`);
process.env.E2E_CONFIG_DIR = E2E_CONFIG_DIR;
const E2E_DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve(import.meta.dirname, "tests/fixtures/config/defaults");
process.env.E2E_DEFAULTS_DIR = E2E_DEFAULTS_DIR;
process.env.E2E_DATABASE_URL = E2E_DATABASE_URL;
// The specs that query the database read the name from the environment: workers inherit it from here.
process.env.E2E_DB_NAME = new URL(E2E_DATABASE_URL).pathname.slice(1);
// The optional web password is on for the run (a throw-away test value): the specs reach the server on 127.0.0.1 and
// pass as local requests; e2e/web-login.spec.ts adds a forwarding header to be a visitor from elsewhere.
const E2E_WEB_PASSWORD = process.env.E2E_WEB_PASSWORD ?? "e2e-web-password-not-secret";
process.env.E2E_WEB_PASSWORD = E2E_WEB_PASSWORD;

// The projects (parallel, exclusive, then the serial chain of specs that rewrite a config file of the run) are planned
// in e2e/projects.ts. Spec files named on the command line run alone, with just the projects they belong to: the
// filters are read once in the main process and handed to the workers (which re-evaluate this file) through the
// environment. E2E_PART optionally selects just the parallel/exclusive projects or the serial chain.
if (process.env.E2E_SPEC_FILTERS === undefined) process.env.E2E_SPEC_FILTERS = JSON.stringify(specFiltersFromArgv(process.argv));
const TEST_DIR = path.resolve(import.meta.dirname, "e2e");
const SPEC_FILTERS = z.array(z.string()).parse(JSON.parse(process.env.E2E_SPEC_FILTERS));
const SPEC_FILES = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith(".spec.ts")).sort();
const projects = planProjects(SPEC_FILES, TEST_DIR, SPEC_FILTERS, process.env.E2E_PART).map((project) => ({ ...project, use: { ...devices["Desktop Chrome"] } }));

export default defineConfig({
  testDir: TEST_DIR,
  // Starts a stand-in runner (heartbeat, config acknowledgement, control requests) after the web server is up.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // CI: annotations on the pull request, a console list, and the HTML report (playwright-report/, uploaded when the run fails; its traces are in the report)
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects,
  webServer: {
    // CI builds in its own step and sets E2E_SKIP_BUILD, so the app is built once per run.
    command: `tsx scripts/e2e-prepare.ts && ${process.env.E2E_SKIP_BUILD ? "" : "pnpm build && "}pnpm start -p ${PORT} -H 127.0.0.1`,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      E2E_ADMIN_DATABASE_URL: ADMIN_DATABASE_URL,
      JOB_RADAR_PROFILE_DIR: E2E_PROFILE_DIR,
      JOB_RADAR_CONFIG_DIR: E2E_CONFIG_DIR,
      JOB_RADAR_DEFAULTS_DIR: E2E_DEFAULTS_DIR,
      // the web has no config watcher: it re-reads the files itself at most this often (the default is 5 s), see e2e/config-refresh.spec.ts
      JOB_RADAR_CONFIG_POLL_MS: "500",
      JOB_RADAR_WEB_PASSWORD: E2E_WEB_PASSWORD,
    },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
