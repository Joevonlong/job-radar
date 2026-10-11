import { stat, statfs } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { loadConfig, type ScheduleConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";

import { resolveDockerDataLocation } from "./docker-data";

/** Free space of a volume, in bytes. */
export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export type DiskLevel = "ok" | "warn" | "fail";

type DiskThresholds = Pick<ScheduleConfig["doctor"], "min_free_disk_gb" | "warn_free_disk_gb">;

/** Below `min_free_disk_gb` is a failure, below `warn_free_disk_gb` a warning (schedule.yaml `doctor`): `pnpm run doctor` and /sources agree. */
export function diskLevel(freeBytes: number, thresholds: DiskThresholds): DiskLevel {
  const freeGb = freeBytes / 1024 ** 3;
  if (freeGb < thresholds.min_free_disk_gb) return "fail";
  if (freeGb < thresholds.warn_free_disk_gb) return "warn";
  return "ok";
}

async function nearestExisting(target: string): Promise<string | null> {
  let current = path.resolve(target);
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Free and total bytes of the volume `target` (or its nearest existing parent) lives on; null when it cannot be read. Shared by `pnpm run doctor` and the ai-worker. */
export async function measureDisk(target: string): Promise<DiskSpace | null> {
  const existing = await nearestExisting(target);
  if (existing === null) return null;
  try {
    const info = await statfs(existing);
    return { freeBytes: Number(info.bavail) * Number(info.bsize), totalBytes: Number(info.blocks) * Number(info.bsize) };
  } catch {
    return null;
  }
}

/** Whether two paths (or their nearest existing parents) are on the same volume (same device id); null when one cannot be read. */
export async function sameVolume(a: string, b: string): Promise<boolean | null> {
  const [first, second] = await Promise.all([nearestExisting(a), nearestExisting(b)]);
  if (first === null || second === null) return null;
  try {
    const [x, y] = await Promise.all([stat(first), stat(second)]);
    return x.dev === y.dev;
  } catch {
    return null;
  }
}

/** The mount point a path visibly belongs to, for messages: `/Volumes/<name>` for an external volume, else the path itself. */
export function volumeLabel(target: string): string {
  const match = /^\/Volumes\/[^/]+/.exec(path.resolve(target));
  return match?.[0] ?? target;
}

/** The path doctor's `disk.docker` check measures: Docker Desktop's data folder (its settings' `DataFolder`). Only meaningful on the host. */
export async function dockerDataPath(): Promise<string> {
  return (await resolveDockerDataLocation()).path;
}

/** The Mac's internal system data volume (`disk.internal`); `/` elsewhere. A missing path is measured at its nearest existing parent. */
export function internalDataPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "/System/Volumes/Data" : "/";
}

/** `runtime_state` key the host ai-worker writes its disk measurement to (no migration needed). */
export const HOST_DISK_KEY = "host_disk";

const hostDiskSchema = z.object({ diskFreeBytes: z.number().nonnegative(), diskTotalBytes: z.number().nonnegative(), diskPath: z.string() });

export interface HostDiskRecord {
  diskFreeBytes: number;
  diskTotalBytes: number;
  diskPath: string;
  /** When the ai-worker measured it (the row's `updated_at`). */
  measuredAt: Date;
}

/** Host side: measure the Docker data volume (the same path as doctor's `disk.docker`) and store it. Returns false when the volume could not be read. */
export async function recordHostDisk(db: Db, target?: string): Promise<boolean> {
  // A configured path means Docker's Group Container settings are never read (they can block under launchd).
  target ??= loadConfig("ai").host_worker.docker_data_path ?? (await dockerDataPath());
  const space = await measureDisk(target);
  if (space === null) return false;
  await setRuntimeState(db, HOST_DISK_KEY, { diskFreeBytes: space.freeBytes, diskTotalBytes: space.totalBytes, diskPath: target });
  return true;
}

/** Newest host measurement, or null when none was ever stored (or the stored value is malformed). */
export async function readHostDisk(db: Db): Promise<HostDiskRecord | null> {
  const row = await getRuntimeState(db, HOST_DISK_KEY);
  if (row === null) return null;
  const parsed = hostDiskSchema.safeParse(row.value);
  return parsed.success ? { ...parsed.data, measuredAt: row.updatedAt } : null;
}

export interface DiskStatus {
  level: DiskLevel;
  freeGb: number;
  /** Size of the measured volume. */
  totalGb: number;
  /** Free share of the volume, 0..100. */
  percent: number;
  minGb: number;
  warnGb: number;
  /** `host`: measured by the host ai-worker on the Docker data volume; `local`: measured inside this process (the container overlay when the web runs in Docker). */
  source: "host" | "local";
  /** Measured path (host measurement only). */
  path: string | null;
}

function statusOf(space: DiskSpace, thresholds: DiskThresholds, source: DiskStatus["source"], measuredPath: string | null): DiskStatus {
  return {
    level: diskLevel(space.freeBytes, thresholds),
    freeGb: space.freeBytes / 1024 ** 3,
    totalGb: space.totalBytes / 1024 ** 3,
    percent: space.totalBytes > 0 ? Math.round((space.freeBytes / space.totalBytes) * 100) : 0,
    minGb: thresholds.min_free_disk_gb,
    warnGb: thresholds.warn_free_disk_gb,
    source,
    path: measuredPath,
  };
}

/** A host measurement older than this many measurement intervals counts as stale (the worker is down or stuck). */
export const HOST_DISK_STALE_INTERVALS = 3;

/** Pure: prefer a recent host measurement, otherwise the local one; null when neither exists. */
export function resolveDiskStatus(input: { host: HostDiskRecord | null; local: DiskSpace | null; now: Date; checkMinutes: number; thresholds: DiskThresholds }): DiskStatus | null {
  const { host, local, now, checkMinutes, thresholds } = input;
  if (host !== null && now.getTime() - host.measuredAt.getTime() <= HOST_DISK_STALE_INTERVALS * checkMinutes * 60_000) {
    return statusOf({ freeBytes: host.diskFreeBytes, totalBytes: host.diskTotalBytes }, thresholds, "host", host.diskPath);
  }
  return local === null ? null : statusOf(local, thresholds, "local", null);
}

/**
 * Disk status for /sources. The web runs in a container, where `statfs` sees the container overlay, not the Mac's disk the
 * Docker data lives on: so the host ai-worker's measurement wins while it is recent, the local one is the fallback.
 */
export async function loadDiskStatus(db: Db | null = null, now: Date = new Date(), target: string = process.cwd()): Promise<DiskStatus | null> {
  try {
    let host: HostDiskRecord | null = null;
    if (db !== null) {
      try {
        host = await readHostDisk(db);
      } catch {
        host = null;
      }
    }
    return resolveDiskStatus({
      host,
      local: await measureDisk(target),
      now,
      checkMinutes: loadConfig("ai").host_worker.disk_check_minutes,
      thresholds: loadConfig("schedule").doctor,
    });
  } catch {
    return null;
  }
}
