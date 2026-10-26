/**
 * Short directory locks shared by the web, runner and host CLI. Same-host owners are checked by PID and process
 * generation; foreign hosts/namespaces can be replaced after the configured stale threshold (default 300 seconds).
 * Commits are fenced against replaced leases. Residual risk: a foreign-namespace process paused longer than that
 * threshold inside a millisecond synchronous arbitration critical section can resume after its guard was replaced.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { ConfigError } from "./errors";
import { loadConfig } from "./load";
import { getConfigDir, getProfileDir } from "./paths";
import { scheduleSchema } from "./schemas/schedule";

export const WRITE_LOCK_FILE = ".write.lock";
export const UPGRADE_FREEZE_FILE = ".upgrade-freeze";
const held = new AsyncLocalStorage<ReadonlyMap<string, string>>();
const heldTokens = new Set<string>();
const processGeneration = { generation: randomBytes(16).toString("hex"), processStartedAt: Date.now() - process.uptime() * 1000 };
const freezeSchema = z.strictObject({ token: z.string().regex(/^[0-9a-f]{32}$/), target: z.string().regex(/^[0-9a-f]{40,64}$/), started: z.iso.datetime() });
const ownerSchema = z.object({
  pid: z.number().int().positive(), host: z.string().min(1), token: z.string().optional(),
  generation: z.string().optional(), processStartedAt: z.number().finite().optional(),
});
export type UpgradeFreeze = z.infer<typeof freezeSchema>;

export function upgradeFreezePath(): string {
  return path.join(getConfigDir(), UPGRADE_FREEZE_FILE);
}

/** A malformed/unreadable marker is still a freeze; only a valid, matching token can bypass it. */
export function assertConfigWritable(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(/*turbopackIgnore: true*/ upgradeFreezePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw configError(file, "frozen");
  }
  try {
    const marker = freezeSchema.parse(JSON.parse(text));
    if (marker.token === process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN) return;
  } catch {
    // Fail closed, without echoing a marker or token.
  }
  throw configError(file, "frozen");
}

function configError(file: string, kind: "busy" | "frozen"): ConfigError {
  return new ConfigError({ configName: path.basename(file), filePath: file, kind });
}

function settings() {
  try {
    return loadConfig("schedule").deploy;
  } catch {
    // Locking must work even while repairing an invalid schedule. Keep defaults in the schema, not in a second policy.
    return scheduleSchema.shape.deploy.parse({ prune_build_cache: true, build_cache_keep_gb: 0, prune_dangling_images: true });
  }
}

/** A reused local PID or an abandoned token is dead; other live local PIDs stay busy, including EPERM. */
function canTakeOver(file: string, policy: ReturnType<typeof settings>): boolean {
  const info = fs.statSync(file);
  let owner: z.infer<typeof ownerSchema> | undefined;
  try {
    owner = ownerSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // An interrupted/legacy owner record has no usable local identity: recover it only after the foreign-host grace.
  }
  if (owner?.host === os.hostname()) {
    if (owner.pid === process.pid) {
      return owner.generation !== processGeneration.generation || owner.processStartedAt !== processGeneration.processStartedAt ||
        owner.token === undefined || !heldTokens.has(owner.token);
    }
    try { process.kill(owner.pid, 0); } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    return false;
  }
  return Date.now() - info.mtimeMs > policy.config_write_lock_stale_seconds * 1000;
}

/**
 * Serialize changes to the canonical lock name. Publishing a prepared, nonempty directory cannot replace another
 * nonempty directory. Release and stale recovery unlink only a unique owner filename, then rmdir: a delayed reaper
 * cannot unlink a successor's owner or remove its nonempty directory. A crash after unlink leaves an empty guard,
 * which the next publication can replace. The guard uses the same conservative host/PID takeover rule as the lease.
 */
async function arbitrate<T>(dir: string, policy: ReturnType<typeof settings>, deadline: number, task: (check: () => void) => T): Promise<T> {
  const lock = path.join(dir, WRITE_LOCK_FILE);
  const guard = `${lock}.guard`;
  let retry = policy.config_write_lock_retry_ms;
  for (;;) {
    const token = randomBytes(16).toString("hex");
    const candidate = `${guard}.pending-${token}`;
    const ownerFile = path.join(guard, token);
    let prepared = false;
    let acquired = false;
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      prepared = true;
      fs.chmodSync(candidate, 0o700);
      fs.writeFileSync(path.join(candidate, token), JSON.stringify({ token, pid: process.pid, host: os.hostname(), ...processGeneration }), { flag: "wx", mode: 0o600 });
      try {
        fs.renameSync(candidate, guard);
        acquired = true;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    } finally {
      if (prepared) fs.rmSync(candidate, { recursive: true, force: true });
    }
    if (acquired) {
      heldTokens.add(token);
      const check = (): void => {
        if (!fs.existsSync(ownerFile)) throw configError(lock, "busy");
      };
      try {
        check();
        // No awaited calls or user work in this critical section. Recheck ownership directly before each mutation.
        return task(check);
      } finally {
        try { removeGuardOwner(guard, token); } finally { heldTokens.delete(token); }
      }
    }
    try {
      const names = fs.readdirSync(guard);
      const generation = names.length === 1 ? names[0] : undefined;
      if (generation && /^[0-9a-f]{32}$/.test(generation)) {
        if (canTakeOver(path.join(guard, generation), policy)) removeGuardOwner(guard, generation);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw configError(lock, "busy");
    await delay(Math.min(retry, Math.max(0, deadline - Date.now())));
    retry = Math.min(retry * 2, policy.config_write_lock_wait_seconds * 1000);
  }
}

function removeGuardOwner(guard: string, token: string): void {
  try { fs.unlinkSync(path.join(guard, token)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try { fs.rmdirSync(guard); } catch (error) {
    if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Reentrant only within the awaited task, so outer freshness/backup checks and the lowest-level writer share a lock. */
export async function withDirectoryWriteLock<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const dir = path.resolve(directory);
  const lock = path.join(dir, WRITE_LOCK_FILE);
  const parent = held.getStore() ?? new Map<string, string>();
  const existing = parent.get(dir);
  if (existing !== undefined) {
    if (await fsp.readFile(lock, "utf8").catch(() => "") !== existing) throw configError(lock, "busy");
    return task();
  }
  const policy = settings();
  const deadline = Date.now() + policy.config_write_lock_wait_seconds * 1000;
  let retry = policy.config_write_lock_retry_ms;
  await fsp.mkdir(dir, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const owner = JSON.stringify({ token, pid: process.pid, host: os.hostname(), ...processGeneration, started: new Date().toISOString() });
  for (;;) {
    const acquired = await arbitrate(dir, policy, deadline, (check) => {
      try {
        if (!canTakeOver(lock, policy)) return false;
        check();
        fs.unlinkSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      check();
      const handle = fs.openSync(lock, "wx", 0o600);
      try {
        fs.fchmodSync(handle, 0o600);
        fs.writeFileSync(handle, owner);
      } catch (error) {
        fs.unlinkSync(lock);
        throw error;
      } finally {
        fs.closeSync(handle);
      }
      return true;
    });
    if (acquired) break;
    if (Date.now() >= deadline) throw configError(lock, "busy");
    await delay(Math.min(retry, Math.max(0, deadline - Date.now())));
    retry = Math.min(retry * 2, policy.config_write_lock_wait_seconds * 1000);
  }
  heldTokens.add(token);
  const scope = new Map(parent).set(dir, owner);
  try {
    return await held.run(scope, task);
  } finally {
    try {
      await arbitrate(dir, policy, Date.now() + policy.config_write_lock_wait_seconds * 1000, (check) => {
        // Comparison and unlink share arbitration with acquisition/takeover: a delayed release cannot delete a successor.
        if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === owner) { check(); fs.unlinkSync(lock); }
      });
    } finally { heldTokens.delete(token); }
  }
}

/** Commit a synchronous filesystem mutation under arbitration, fenced against a replaced canonical lease. */
export function commitConfigWrite<T>(file: string, mutation: () => T): Promise<T> {
  return commitDirectoryWrite(file, mutation, true);
}

async function commitDirectoryWrite<T>(file: string, mutation: () => T, checkFreeze: boolean): Promise<T> {
  const dir = path.resolve(path.dirname(file));
  const lock = path.join(dir, WRITE_LOCK_FILE);
  const owner = held.getStore()?.get(dir);
  const policy = settings();
  return arbitrate(dir, policy, Date.now() + policy.config_write_lock_wait_seconds * 1000, (check) => {
    if (owner === undefined || !fs.existsSync(lock) || fs.readFileSync(lock, "utf8") !== owner) throw configError(lock, "busy");
    if (checkFreeze) assertConfigWritable(file);
    check();
    return mutation();
  });
}

/** Every lowest-level writer checks the freeze after taking its directory lock. */
export function withConfigWriteLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  return withDirectoryWriteLock(path.dirname(file), async () => {
    assertConfigWritable(file);
    return task();
  });
}

/** Fixed order for a multi-file operation; also excludes in-flight profile saves when creating/removing a freeze. */
export function withUserDirectoryLocks<T>(task: () => Promise<T>): Promise<T> {
  return withDirectoryWriteLock(getConfigDir(), () => withDirectoryWriteLock(getProfileDir(), task));
}

/** Marker operations must still own both directory leases after waiting for them in the fixed order. */
function assertUserDirectoryLeases(): void {
  for (const dir of [getConfigDir(), getProfileDir()]) {
    const lock = path.join(dir, WRITE_LOCK_FILE);
    const owner = held.getStore()?.get(path.resolve(dir));
    if (owner === undefined || !fs.existsSync(lock) || fs.readFileSync(lock, "utf8") !== owner) throw configError(lock, "busy");
  }
}

/** Replaces a leftover freeze on the next deploy; only returns the token to the invoking deploy process. */
export async function freezeConfig(target: string, token = randomBytes(16).toString("hex")): Promise<UpgradeFreeze> {
  const marker = freezeSchema.parse({ token, target, started: new Date().toISOString() });
  return withUserDirectoryLocks(async () => {
    await commitDirectoryWrite(upgradeFreezePath(), () => {
      assertUserDirectoryLeases();
      fs.writeFileSync(upgradeFreezePath(), JSON.stringify(marker), { mode: 0o600 });
      fs.chmodSync(upgradeFreezePath(), 0o600);
    }, false);
    return marker;
  });
}

/** An optional token prevents one deploy from removing a freeze replaced by a later deploy. */
export async function unfreezeConfig(token?: string): Promise<void> {
  await withUserDirectoryLocks(async () => {
    await commitDirectoryWrite(upgradeFreezePath(), () => {
      assertUserDirectoryLeases();
      if (token !== undefined) {
        const marker = freezeSchema.parse(JSON.parse(fs.readFileSync(upgradeFreezePath(), "utf8")));
        if (token !== marker.token) throw configError(upgradeFreezePath(), "frozen");
      }
      fs.rmSync(upgradeFreezePath(), { force: true });
    }, false);
  });
}
