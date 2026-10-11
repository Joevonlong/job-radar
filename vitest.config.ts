import os from "node:os";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// A test that reads config without building its own (tests/config/helpers.ts makeTempConfig) gets the frozen
// fixture snapshot, never the repository's config/ (generic defaults) or a real user / profile directory.
const TEST_CONFIG_ENV = {
  JOB_RADAR_DEFAULTS_DIR: path.resolve(import.meta.dirname, "tests/fixtures/config/defaults"),
  JOB_RADAR_CONFIG_DIR: path.join(os.tmpdir(), "job-radar-test-no-user-config"),
  JOB_RADAR_PROFILE_DIR: path.join(os.tmpdir(), "job-radar-test-no-profile"),
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    exclude: ["tests/integration/**", "node_modules/**"],
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    css: false,
    // Tests are deterministic (fake timers / injected clocks); the limits only catch hangs. They are generous
    // so a machine under heavy load (many parallel suites) slows tests down without failing them.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: TEST_CONFIG_ENV,
  },
});
