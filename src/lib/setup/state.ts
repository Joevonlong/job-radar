/**
 * The setup state (config/setup.yaml in the user config directory). Server / Node only.
 *
 * "Setup pending" = the file is readable and `completed_at` is null. Everything else counts as completed, so a problem
 * never locks anyone into the wizard: an unreadable or invalid file (the doctor reports it), and an install whose user
 * directory holds config files but no setup.yaml (an install from before the wizard; its first start writes the file,
 * and a runner that cannot write the directory reads it the same way meanwhile).
 */
import fs from "node:fs";

import { ConfigError, getConfigDir, getDefaultConfigPath, getUserConfigPath, isExistingInstall, parseConfigText, writeConfig, type SetupConfig } from "@/lib/config";

import { type SetupCompletedBy, type SetupStepId, type SetupStepStatus } from "./steps";

export type SetupSource =
  /** The user's setup.yaml. */
  | "user"
  /** No user file: the shipped default (a fresh install). */
  | "default"
  /** No user file, but other config files: an install from before the wizard (treated as completed). */
  | "existing_install"
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
  /** The file read (user or default); null for `existing_install` / `missing`. */
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
    text = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
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
    if (isExistingInstall(getConfigDir())) return { pending: false, state: null, error: null, source: "existing_install", path: null };
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
 * The state a write starts from. A readable file: its content. No file on an existing install: "completed", so marking
 * a step there can never turn the install into a pending one. An unreadable or invalid file: null (nothing is written;
 * the doctor reports the file).
 */
function baseForWrite(now: Date): SetupConfig | null {
  const status = readSetupState();
  if (status.state !== null) return status.state;
  if (status.error !== null) return null;
  if (status.source === "existing_install") return { completed_at: now.toISOString(), completed_by: "existing_install", steps: {} };
  return { completed_at: null, completed_by: null, steps: {} };
}

export type SetupWriteResult = { ok: true; state: SetupConfig } | { ok: false; reason: "unreadable" | "write_failed" | "frozen" };

async function write(next: SetupConfig): Promise<SetupWriteResult> {
  try {
    const state = await writeConfig("setup", next);
    resetSetupStateCache();
    return { ok: true, state };
  } catch (error) {
    return { ok: false, reason: error instanceof ConfigError && error.kind === "frozen" ? "frozen" : "write_failed" };
  }
}

/** Record what happened to one step (`done` after a save, `skipped` when passed over). */
export async function markStep(id: SetupStepId, status: SetupStepStatus, now: Date = new Date()): Promise<SetupWriteResult> {
  const base = baseForWrite(now);
  if (base === null) return { ok: false, reason: "unreadable" };
  return write({ ...base, steps: { ...base.steps, [id]: { status, at: now.toISOString() } } });
}

/**
 * Mark the setup complete. A setup that is already complete keeps its time and `completed_by` (opening the wizard again
 * from the settings page and pressing "finish" changes nothing).
 */
export async function completeSetup(by: SetupCompletedBy, now: Date = new Date()): Promise<SetupWriteResult> {
  const base = baseForWrite(now);
  if (base === null) return { ok: false, reason: "unreadable" };
  if (base.completed_at !== null && readSetupState().source === "user") return { ok: true, state: base };
  return write({ ...base, completed_at: base.completed_at ?? now.toISOString(), completed_by: base.completed_by ?? by });
}
