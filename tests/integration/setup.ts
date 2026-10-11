import { afterAll, beforeAll, beforeEach, inject } from "vitest";

import { resetDatabase } from "./reset";

/**
 * Every integration file starts with, and leaves behind, an empty database.
 *
 * The files of a run share one database (see global-setup.ts), and several of them used to leave
 * companies, jobs, cycles, heartbeats ... behind, so whether a test passed depended on which file
 * ran before it. This setup file is registered for every integration file: it truncates all application
 * tables (migrations are applied once by global-setup) before the file's own hooks run and again after
 * they ran (hooks that run after tests run in reverse, so this one is last).
 *
 * It also empties them before every single test, so tests inside a file cannot depend on each other either:
 * a file arranges the rows a test needs in its own `beforeEach` or in the test itself, and `--sequence.shuffle`
 * (any seed) passes.
 */
beforeAll(async () => {
  await resetDatabase(inject("testDatabaseUrl"));
});

// Each test starts on empty tables (a file's own beforeEach hooks run after this one and arrange the rows it needs).
beforeEach(async () => {
  await resetDatabase(inject("testDatabaseUrl"));
});

afterAll(async () => {
  await resetDatabase(inject("testDatabaseUrl"));
});
