/**
 * Stops an old worker from working against config files newer than its code. Web saves and a deploy's writes can reach the
 * files while a worker from before the upgrade still runs: it would read such a file as an error and fail requests one by one.
 * Only `config_version` is read here (a full load already reports problems of other kinds).
 */
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { parse as parseYaml } from "yaml";

import { CONFIG_NAMES, currentConfigVersion, getUserConfigPath, type ConfigName } from "@/lib/config";

export interface NewerConfigFile {
  name: ConfigName;
  path: string;
  version: number;
  supported: number;
}

/** Per file: the stat it was read at and the version found. A file that did not change is not read again. */
export type VersionCache = Map<string, { mtimeMs: number; size: number; version: number | null }>;

function fileVersion(file: string, cache: VersionCache): number | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(/*turbopackIgnore: true*/ file);
  } catch {
    cache.delete(file);
    return null;
  }
  const known = cache.get(file);
  if (known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.version;
  let version: number | null = null;
  try {
    const doc: unknown = parseYaml(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
    const value = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>).config_version : undefined;
    version = typeof value === "number" && Number.isInteger(value) ? value : null;
  } catch {
    // not readable as YAML: reported by the load
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, version });
  return version;
}

export interface VersionStopOptions {
  /** Seconds to wait before exiting, read only when stopping. */
  waitSeconds: () => number;
  /** Puts a request this worker just claimed back in the queue. */
  release: (requestId: number) => Promise<void>;
  log: (message: string) => void;
  /** Ends the process. */
  exit: (code: number) => void;
}

/**
 * The check the worker runs before touching the queue, before every claim and after it. Given the id of a request it has
 * just claimed, that request goes back to the queue first, for the upgraded worker. A failed release still stops: the
 * next start queues a request left `running` again.
 */
export function createVersionStop(options: VersionStopOptions): (claimedRequestId?: number) => Promise<void> {
  const versions: VersionCache = new Map();
  return async (claimedRequestId) => {
    const newer = newerConfigFiles(versions);
    if (newer.length === 0) return;
    if (claimedRequestId !== undefined) {
      await options.release(claimedRequestId).catch((error: unknown) => {
        options.log(`could not put request #${claimedRequestId} back: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    }
    const waitSeconds = options.waitSeconds();
    options.log(`config files newer than this code: ${newer.map((file) => `${file.name} v${file.version} (reads up to v${file.supported})`).join(", ")}. Exiting${waitSeconds > 0 ? ` in ${waitSeconds}s` : ""}; the upgraded worker takes over`);
    if (waitSeconds > 0) await sleep(waitSeconds * 1000);
    options.exit(1);
  };
}

/** The user's config and profile files whose `config_version` is newer than this code reads. */
export function newerConfigFiles(cache: VersionCache = new Map()): NewerConfigFile[] {
  const newer: NewerConfigFile[] = [];
  for (const name of CONFIG_NAMES) {
    const file = getUserConfigPath(name);
    const version = fileVersion(file, cache);
    const supported = currentConfigVersion(name);
    if (version !== null && version > supported) newer.push({ name, path: file, version, supported });
  }
  return newer;
}
