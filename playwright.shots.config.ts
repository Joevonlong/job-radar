import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { blankEnv } from "./e2e-demo/clean-env";
import { demoInstance } from "./scripts/demo/checks";
import { DEMO_PORT, DESKTOP_VIEWPORT, LOCAL_DIR, VIDEO_VIEWPORT } from "./scripts/demo/settings";

/**
 * The README screenshots and demo GIF (`pnpm demo:shots`, see docs/images/README.md). Not part of `pnpm test:e2e`: that
 * config only reads e2e/. Runs a production build against a throw-away demo database (`jobradar_demo*`), a temp config
 * and profile directory, and a clean environment (the project's `.env` is never read). The pictures land in a staging
 * directory first; `scripts/demo-finish.ts` moves them to docs/images/ once the whole run passed.
 */

// ---- the throw-away instance (checked: a jobradar_demo* database, temp directories) ------------------------------------
const instance = demoInstance();
const ADMIN_DATABASE_URL = instance.adminUrl;
const DEMO_DATABASE_URL = instance.databaseUrl;
const DEMO_CONFIG_DIR = instance.configDir;
const DEMO_PROFILE_DIR = instance.profileDir;
const DEFAULTS_DIR = path.resolve(import.meta.dirname, "config");

// The specs and the stand-in runner (e2e/global-setup.ts) read these.
process.env.E2E_DATABASE_URL = DEMO_DATABASE_URL;
process.env.E2E_CONFIG_DIR = DEMO_CONFIG_DIR;
process.env.E2E_PROFILE_DIR = DEMO_PROFILE_DIR;
process.env.E2E_DEFAULTS_DIR = DEFAULTS_DIR;
process.env.DATABASE_URL = DEMO_DATABASE_URL;
process.env.JOB_RADAR_CONFIG_DIR = DEMO_CONFIG_DIR;
process.env.JOB_RADAR_PROFILE_DIR = DEMO_PROFILE_DIR;
process.env.JOB_RADAR_DEFAULTS_DIR = DEFAULTS_DIR;

const use = { ...devices["Desktop Chrome"], viewport: DESKTOP_VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce" as const, colorScheme: "light" as const };

export default defineConfig({
  testDir: "./e2e-demo",
  outputDir: path.join(LOCAL_DIR, "test-results"),
  // the stand-in runner: heartbeat and config acknowledgement, so the pages show a healthy install
  globalSetup: "./e2e-demo/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${DEMO_PORT}`, trace: "off" },
  projects: [
    { name: "clean-env", testMatch: /clean-env\.spec\.ts$/, use },
    { name: "shots", testMatch: /shots\.spec\.ts$/, dependencies: ["clean-env"], use },
    // last: it moves a card on the board
    {
      name: "gif",
      testMatch: /gif\.spec\.ts$/,
      dependencies: ["shots"],
      use: { ...use, viewport: VIDEO_VIEWPORT, video: { mode: "on", size: VIDEO_VIEWPORT } },
    },
  ],
  webServer: {
    command: `tsx scripts/demo-prepare.ts && ${process.env.DEMO_SKIP_BUILD ? "" : "pnpm build && "}pnpm start -p ${DEMO_PORT} -H 127.0.0.1`,
    env: {
      ...blankEnv(import.meta.dirname),
      DEMO_ADMIN_DATABASE_URL: ADMIN_DATABASE_URL,
      DEMO_DB_NAME: instance.dbName,
      DEMO_CONFIG_DIR,
      DEMO_PROFILE_DIR,
      DATABASE_URL: DEMO_DATABASE_URL,
      JOB_RADAR_CONFIG_DIR: DEMO_CONFIG_DIR,
      JOB_RADAR_PROFILE_DIR: DEMO_PROFILE_DIR,
      JOB_RADAR_DEFAULTS_DIR: DEFAULTS_DIR,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    url: `http://127.0.0.1:${DEMO_PORT}`,
    // never attach to a server that happens to listen on the port: it could be a real installation
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
