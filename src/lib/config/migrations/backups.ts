/** Pruning the `config:migrate` backups (`<user config dir>/.backup/<timestamp>/`). The editor's `.backup/editor/` keeps its own count. */
import fsp from "node:fs/promises";
import path from "node:path";

import { getConfigDir } from "../paths";
import { configWriteSettings, withConfigWriteLock } from "../write-lock";

const BACKUP_DIRECTORY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/** Remove the oldest timestamped backups beyond `schedule.yaml: config_writes.backups_keep`. Returns the directories removed. */
export async function pruneConfigBackups(): Promise<string[]> {
  const root = path.join(getConfigDir(), ".backup");
  let entries: string[];
  try {
    entries = (await fsp.readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && BACKUP_DIRECTORY.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const stale = entries.sort().slice(0, Math.max(0, entries.length - configWriteSettings().backups_keep));
  if (stale.length === 0) return [];
  return withConfigWriteLock(async () => {
    for (const name of stale) await fsp.rm(/*turbopackIgnore: true*/ path.join(root, name), { recursive: true, force: true });
    return stale.map((name) => path.join(root, name));
  }, root);
}
