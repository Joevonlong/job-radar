import os from "node:os";
import path from "node:path";

import { defineConfig } from "vitest/config";

// Integration tests run against a real Postgres. DATABASE_URL must point at a server where the
// connecting role may CREATE DATABASE: each run creates a uniquely named database and drops it
// afterwards (see tests/integration/global-setup.ts). Nothing else on the server is touched.
// A test that reads config without building its own (tests/config/helpers.ts makeTempConfig) gets the frozen
// fixture snapshot, never the repository's config/ (generic defaults) or a real user / profile directory.
const TEST_CONFIG_ENV = {
  JOB_RADAR_DEFAULTS_DIR: path.resolve(import.meta.dirname, "tests/fixtures/config/defaults"),
  JOB_RADAR_CONFIG_DIR: path.join(os.tmpdir(), "job-radar-test-no-user-config"),
  JOB_RADAR_PROFILE_DIR: path.join(os.tmpdir(), "job-radar-test-no-profile"),
};

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    // empties the shared database before and after every file, so no file depends on another's leftovers
    setupFiles: ["./tests/integration/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // One shared database per run: keep files sequential to avoid cross-file interference.
    fileParallelism: false,
    // On a loaded machine (parallel workers, local CI containers) a new connection can take longer than the
    // app's 5 s default; a slow connect is not what these tests check.
    env: { DB_CONNECT_TIMEOUT_SECONDS: "30", ...TEST_CONFIG_ENV },
  },
});
