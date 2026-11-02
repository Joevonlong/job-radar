/**
 * The write lock of the user's config and profile files: every writer in the web, the runner and host commands takes it,
 * one file at a time, so a save and a deploy's writes never interleave.
 *
 * What it guarantees: writes are serialized only while the session holding the lock stays alive. The ownership check
 * (`fence`) does not fence the commit on the filesystem: when the session is lost after the check, the write still lands
 * and a later writer may overwrite it. How long that exposure lasts has no upper bound.
 *
 * Order: the in-process file lock (`withFileLock`) first, then this lock. All SQL is in `src/lib/db/config-write-lock.ts`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

import { resolveHostDatabaseUrl } from "../ops/doctor/database-url";

import { ConfigError } from "./errors";
import { loadConfig } from "./load";
import { getConfigDir, getProfileDir } from "./paths";
import { scheduleSchema, type ConfigWritesConfig } from "./schemas/schedule";

export interface ConfigWriteLockSession {
  /** True only while this session still holds the lock. Never throws. */
  fence(): Promise<boolean>;
  release(): Promise<void>;
}

export type ConfigWriteLockAttempt = { acquired: true; lock: ConfigWriteLockSession } | { acquired: false; holder: string | null };

/** Where the lock comes from: the database, or an in-process stand-in in unit tests (`tests/setup.ts`). */
export type ConfigWriteLockProvider = (options: { waitSeconds: number }) => Promise<ConfigWriteLockAttempt>;

const PROVIDER_SLOT = Symbol.for("job-radar.config-write-lock-provider");

type ProviderSlot = { [PROVIDER_SLOT]?: ConfigWriteLockProvider | null };

/** For tests/setup.ts only. Kept on globalThis so a test that resets the module registry keeps its stand-in. */
export function setConfigWriteLockProviderForTests(provider: ConfigWriteLockProvider | null): void {
  if (process.env.VITEST !== "true") throw new Error("the config write lock provider can only be replaced under vitest");
  (globalThis as ProviderSlot)[PROVIDER_SLOT] = provider;
}

const held = new AsyncLocalStorage<ConfigWriteLockSession>();

/** `schedule.yaml: config_writes`, or the schema's defaults when the file cannot be read: a repair must still be saved. */
export function configWriteSettings(): ConfigWritesConfig {
  try {
    return loadConfig("schedule").config_writes;
  } catch {
    return scheduleSchema.shape.config_writes.parse(undefined);
  }
}

function busy(file: string, detail: string): ConfigError {
  return new ConfigError({ configName: path.basename(file), filePath: file, kind: "busy", detail });
}

/** Thrown when the session was lost between taking the lock and the commit. */
export function lockLostError(file: string): ConfigError {
  return busy(file, "lock_lost");
}

const databaseProvider: ConfigWriteLockProvider = async ({ waitSeconds }) => {
  // Loaded on first use: a process that only reads config never needs the database driver.
  const { acquireConfigWriteLock } = await import("../db/config-write-lock");
  const result = await acquireConfigWriteLock(resolveHostDatabaseUrl(process.env), { waitSeconds });
  return result.acquired ? { acquired: true, lock: result.lock } : { acquired: false, holder: result.holder?.application ?? null };
};

async function attempt(file: string): Promise<ConfigWriteLockSession> {
  const provider = (globalThis as ProviderSlot)[PROVIDER_SLOT] ?? databaseProvider;
  let result: ConfigWriteLockAttempt;
  try {
    result = await provider({ waitSeconds: configWriteSettings().lock_wait_seconds });
  } catch (error) {
    if (error instanceof Error && error.name === "DbUnavailable") throw new ConfigError({ configName: path.basename(file), filePath: file, kind: "db_unavailable" });
    throw error;
  }
  if (!result.acquired) throw busy(file, result.holder ?? "unknown holder");
  return result.lock;
}

/**
 * Run `fn` holding the lock. A nested call shares the lock it is already in; that is only for the commit of one file:
 * a writer takes the lock per file, so another process never waits longer than one file's commit.
 * `file` only names the file in the errors. Throws ConfigError `busy` (waited `config_writes.lock_wait_seconds`) or
 * `db_unavailable`.
 */
export async function withConfigWriteLock<T>(fn: (session: Pick<ConfigWriteLockSession, "fence">) => Promise<T>, file: string = getConfigDir()): Promise<T> {
  const current = held.getStore();
  if (current !== undefined) return fn(current);
  const session = await attempt(file);
  try {
    return await held.run(session, () => fn(session));
  } finally {
    await session.release();
  }
}

/** The lock this call chain holds, or null. */
export function currentConfigWriteLock(): Pick<ConfigWriteLockSession, "fence"> | null {
  return held.getStore() ?? null;
}

/** Under the user config or profile directory: a writer there must hold the lock. */
export function isLockedConfigPath(file: string): boolean {
  const resolved = path.resolve(file);
  return [getConfigDir(), getProfileDir()].some((dir) => {
    const relative = path.relative(path.resolve(dir), resolved);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
  });
}

/**
 * A place to stop a child process in the cross-process tests: with `JOB_RADAR_TEST_LOCK_PAUSE=<stage>:<directory>` (and
 * only under NODE_ENV=test) the writer creates `<directory>/reached` at that stage and goes on once `<directory>/go` exists.
 */
export async function lockTestPause(stage: string): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const spec = process.env.JOB_RADAR_TEST_LOCK_PAUSE;
  if (!spec?.startsWith(`${stage}:`)) return;
  const dir = spec.slice(stage.length + 1);
  fs.writeFileSync(/*turbopackIgnore: true*/ path.join(dir, "reached"), "");
  while (!fs.existsSync(/*turbopackIgnore: true*/ path.join(dir, "go"))) await new Promise((resolve) => setTimeout(resolve, 20));
}
