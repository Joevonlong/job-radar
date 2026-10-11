/**
 * Where Docker Desktop keeps its disk image: the `DataFolder` of its settings. `pnpm run doctor`'s `disk.docker` and the
 * ai-worker's `host_disk` measurement both use it, so they measure the volume the database really lives on (the external SSD
 * once the operator moved it there). Host-side only.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

/** `settings-store`: Docker Desktop 4.3x+ (`DataFolder`); `settings`: older releases (`dataFolder`); `default`: neither was readable; `home`: not macOS. */
export type DockerDataSource = "settings-store" | "settings" | "default" | "home";

export interface DockerDataLocation {
  /** Absolute path of the folder that holds Docker Desktop's disk image (it may not exist; measure its nearest existing parent). */
  path: string;
  source: DockerDataSource;
}

/** Docker Desktop's settings, relative to the home directory. */
export const DOCKER_SETTINGS_DIR = "Library/Group Containers/group.com.docker";
/** Where Docker Desktop keeps its disk image when nobody moved it, relative to the home directory. */
export const DOCKER_DEFAULT_DATA_DIR = "Library/Containers/com.docker.docker/Data/vms/0/data";

const absolutePath = z.string().trim().min(1).refine((value) => path.isAbsolute(value), "must be an absolute path");
const settingsStoreSchema = z.object({ DataFolder: absolutePath });
const legacySettingsSchema = z.object({ dataFolder: absolutePath });

export type ReadText = (file: string) => Promise<string>;

async function readJson(file: string, readText: ReadText): Promise<unknown> {
  try {
    return JSON.parse(await readText(file));
  } catch {
    return null;
  }
}

/** Resolve Docker Desktop's data folder; never throws (an unreadable or odd settings file falls back to the default location). */
export async function resolveDockerDataLocation(options: { homeDir?: string; platform?: NodeJS.Platform; readText?: ReadText } = {}): Promise<DockerDataLocation> {
  const home = options.homeDir ?? os.homedir();
  if ((options.platform ?? process.platform) !== "darwin") return { path: home, source: "home" };
  const readText = options.readText ?? ((file: string) => readFile(file, "utf8"));
  const settingsDir = path.join(home, DOCKER_SETTINGS_DIR);

  const store = settingsStoreSchema.safeParse(await readJson(path.join(settingsDir, "settings-store.json"), readText));
  if (store.success) return { path: path.normalize(store.data.DataFolder), source: "settings-store" };
  const legacy = legacySettingsSchema.safeParse(await readJson(path.join(settingsDir, "settings.json"), readText));
  if (legacy.success) return { path: path.normalize(legacy.data.dataFolder), source: "settings" };
  return { path: path.join(home, DOCKER_DEFAULT_DATA_DIR), source: "default" };
}
