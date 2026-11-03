/**
 * The setup state (config/setup.yaml in the user config directory). Server / Node only.
 *
 * "Setup pending" = the file is readable and `completed_at` is null, or there is no user file and the shipped default says
 * so: a missing setup.yaml always opens the wizard, whatever else the directory holds. An unreadable or invalid file counts
 * as completed, so a problem never locks anyone into the wizard (the doctor reports it).
 */
import fs from "node:fs";
import path from "node:path";

import { commitConfigFile, ConfigError, getDefaultConfigPath, getUserConfigPath, mutateConfig, parseConfigText, withConfigWriteLock, withFileLock, type SetupConfig } from "@/lib/config";

import { readUserText } from "@/lib/config/read-user-file";
import { type SetupCompletedBy, type SetupStepId, type SetupStepStatus } from "./steps";

export type SetupSource =
  /** The user's setup.yaml. */
  | "user"
  /** No user file: the shipped default (a fresh install). */
  | "default"
  /** No file anywhere. */
  | "missing";

export interface SetupStatus {
  /** Pages open the wizard and the runner holds back its scheduled work. */
  pending: boolean;
  /** The parsed file; null when it is missing or cannot be read. */
  state: SetupConfig | null;
  /** Why the file cannot be read (first line); null when it can (or there is none). */
  error: string | null;
  source: SetupSource;
  /** The file read (user or default); null for `missing`. */
  path: string | null;
}

interface CacheEntry {
  key: string;
  status: SetupStatus;
}

let cache: CacheEntry | null = null;

/** Size and mtime of a file, or null when it does not exist. */
function fileStamp(file: string): string | null {
  try {
    const stat = fs.statSync(/*turbopackIgnore: true*/ file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function firstLine(error: unknown): string {
  if (error instanceof ConfigError) return error.message.split("\n").slice(0, 2).join(" ").trim();
  return error instanceof Error ? (error.message.split("\n")[0] ?? "unreadable") : "unreadable";
}

function readFile(file: string, source: "user" | "default"): SetupStatus {
  let text: string;
  try {
    text = readUserText(file);
  } catch (error) {
    return { pending: false, state: null, error: firstLine(error), source, path: file };
  }
  try {
    const state = parseConfigText("setup", text, file);
    return { pending: state.completed_at === null, state, error: null, source, path: file };
  } catch (error) {
    return { pending: false, state: null, error: firstLine(error), source, path: file };
  }
}

/**
 * The current setup state. Cached by the file's mtime and size (the proxy calls this on every page request), so a
 * change by another process (the CLI, the runner reading what the web wrote) is seen on the next call. Never throws.
 */
export function readSetupState(): SetupStatus {
  try {
    const userFile = getUserConfigPath("setup");
    const userStamp = fileStamp(userFile);
    if (userStamp !== null) {
      const key = `user\u0000${userFile}\u0000${userStamp}`;
      if (cache?.key === key) return cache.status;
      const status = readFile(userFile, "user");
      cache = { key, status };
      return status;
    }
    const defaultFile = getDefaultConfigPath("setup");
    const defaultStamp = defaultFile === null ? null : fileStamp(defaultFile);
    if (defaultFile === null || defaultStamp === null) return { pending: false, state: null, error: null, source: "missing", path: null };
    const key = `default\u0000${defaultFile}\u0000${defaultStamp}`;
    if (cache?.key === key) return cache.status;
    const status = readFile(defaultFile, "default");
    cache = { key, status };
    return status;
  } catch (error) {
    return { pending: false, state: null, error: firstLine(error), source: "missing", path: null };
  }
}

/** Drop the cached state (tests). */
export function resetSetupStateCache(): void {
  cache = null;
}

/**
 * The state a write starts from. A readable file: its content. An unreadable or invalid file: null (nothing is written;
 * the doctor reports the file).
 */
function baseForWrite(): SetupConfig | null {
  const status = readSetupState();
  if (status.state !== null) return status.state;
  if (status.error !== null) return null;
  return { completed_at: null, completed_by: null, steps: {} };
}

export type SetupWriteResult = { ok: true; state: SetupConfig } | { ok: false; reason: "unreadable" | "write_failed" | "busy" | "db_unavailable" };

async function write(update: (base: SetupConfig) => SetupConfig | null): Promise<SetupWriteResult> {
  try {
    let state: SetupConfig | null = null;
    await mutateConfig("setup", () => {
      resetSetupStateCache();
      const base = baseForWrite();
      if (base === null) return null;
      const next = update(base);
      state = next ?? base;
      return next;
    });
    resetSetupStateCache();
    return state === null ? { ok: false, reason: "unreadable" } : { ok: true, state };
  } catch (error) {
    return { ok: false, reason: !(error instanceof ConfigError) ? "write_failed" : error.kind === "busy" || error.kind === "db_unavailable" ? error.kind : ["missing", "yaml", "schema", "version"].includes(error.kind) ? "unreadable" : "write_failed" };
  }
}

/** Record what happened to one step (`done` after a save, `skipped` when passed over). */
export async function markStep(id: SetupStepId, status: SetupStepStatus, now: Date = new Date()): Promise<SetupWriteResult> {
  return write((base) => ({ ...base, steps: { ...base.steps, [id]: { status, at: now.toISOString() } } }));
}

/**
 * Mark the setup complete. A setup that is already complete keeps its time and `completed_by` (opening the wizard again
 * from the settings page and pressing "finish" changes nothing).
 */
export async function completeSetup(by: SetupCompletedBy, now: Date = new Date()): Promise<SetupWriteResult> {
  return write((base) => base.completed_at !== null && readSetupState().source === "user" ? null : { ...base, completed_at: base.completed_at ?? now.toISOString(), completed_by: base.completed_by ?? by });
}

export type EnsurePendingSetupResult = { ok: true; existed: boolean } | { ok: false; formError: "busy" | "dbUnavailable" | "setupUnreadable" };

/** How long a `.setup.yaml.*.tmp` may lie around before it counts as left behind by an interrupted write. */
const ABANDONED_TEMP_MS = 60 * 60 * 1000;

function removeAbandonedSetupTemps(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(/*turbopackIgnore: true*/ dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".setup.yaml.") || !name.endsWith(".tmp")) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(/*turbopackIgnore: true*/ file).mtimeMs > ABANDONED_TEMP_MS) fs.rmSync(/*turbopackIgnore: true*/ file, { force: true });
    } catch {
      // gone already
    }
  }
}

/**
 * Create the pending setup.yaml before a step's first write, so a backup taken after any wizard save holds it. Its own
 * commit (file lock, then the config write lock), publishing without ever replacing: a file that appeared meanwhile stays.
 * Failures come back as the step's form error, nothing throws.
 */
export async function ensurePendingSetupFile(now: Date = new Date()): Promise<EnsurePendingSetupResult> {
  const target = getUserConfigPath("setup");
  try {
    return await withFileLock(target, () => withConfigWriteLock(async (): Promise<EnsurePendingSetupResult> => {
      removeAbandonedSetupTemps(path.dirname(target), now.getTime());
      if (fs.existsSync(/*turbopackIgnore: true*/ target)) return { ok: true, existed: true };
      const shipped = getDefaultConfigPath("setup");
      if (shipped === null) return { ok: false, formError: "setupUnreadable" };
      const text = fs.readFileSync(/*turbopackIgnore: true*/ shipped, "utf8");
      const outcome = await commitConfigFile(target, text, { mode: "create", verify: (content) => void parseConfigText("setup", content.toString("utf8"), target) });
      resetSetupStateCache();
      return { ok: true, existed: outcome === "existed" };
    }, target));
  } catch (error) {
    if (error instanceof ConfigError && error.kind === "busy") return { ok: false, formError: "busy" };
    if (error instanceof ConfigError && error.kind === "db_unavailable") return { ok: false, formError: "dbUnavailable" };
    return { ok: false, formError: "setupUnreadable" };
  }
}
