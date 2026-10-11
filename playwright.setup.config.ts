import os from "node:os";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * The first-run setup wizard on a brand-new install (`pnpm test:e2e:setup`). Its own port, database and
 * directories, so it never shares state with the main suite (playwright.config.ts): `scripts/e2e-prepare.ts --fresh`
 * empties the config and profile directories (the web fills them on start, as on a first `docker compose up`) and drops,
 * recreates and migrates the database without the seed. No stand-in runner: requested cycles stay queued.
 * `E2E_SETUP_PORT` picks the port; with `E2E_PORT` set (one port per worktree) the default is that port + 5.
 */
const BASE_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : null;
const PORT = Number(process.env.E2E_SETUP_PORT ?? (BASE_PORT !== null ? BASE_PORT + 5 : 3105));
const SUFFIX = `_${PORT}`;

const ADMIN_DATABASE_URL = process.env.E2E_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://jobradar:jobradar@127.0.0.1:5433/jobradar";
const DATABASE_URL = (() => {
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/jobradar_e2e_setup${SUFFIX}`;
  return url.toString();
})();
const CONFIG_DIR = path.join(os.tmpdir(), `job-radar-e2e-setup-config${SUFFIX.replace("_", "-")}`);
const PROFILE_DIR = path.join(os.tmpdir(), `job-radar-e2e-setup-profile${SUFFIX.replace("_", "-")}`);
// the frozen test fixture, like the main suite: tests never depend on the repository's shipped defaults
const DEFAULTS_DIR = path.resolve(import.meta.dirname, "tests/fixtures/config/defaults");

// the spec reads and writes the files of the run, and queries the database
process.env.E2E_SETUP_CONFIG_DIR = CONFIG_DIR;
process.env.E2E_SETUP_PROFILE_DIR = PROFILE_DIR;
process.env.E2E_SETUP_DATABASE_URL = DATABASE_URL;

export default defineConfig({
  testDir: "./e2e-setup",
  // one install walked through in order: the specs share it
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never", outputFolder: "playwright-report-setup" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "setup-wizard", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `tsx scripts/e2e-prepare.ts --fresh && ${process.env.E2E_SKIP_BUILD ? "" : "pnpm build && "}pnpm start -p ${PORT} -H 127.0.0.1`,
    env: {
      DATABASE_URL,
      E2E_ADMIN_DATABASE_URL: ADMIN_DATABASE_URL,
      JOB_RADAR_PROFILE_DIR: PROFILE_DIR,
      JOB_RADAR_CONFIG_DIR: CONFIG_DIR,
      JOB_RADAR_DEFAULTS_DIR: DEFAULTS_DIR,
    },
    url: `http://127.0.0.1:${PORT}/api/health`,
    // always a fresh install: never reuse a server that already went through the wizard
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
