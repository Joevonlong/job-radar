/**
 * Before the advanced editor replaces or deletes a user config file, the old text is copied to
 * `<user config dir>/.backup/editor/<timestamp>/<file>`. Each file keeps its newest `keep` copies. (the layered config's
 * `pnpm config:migrate` backups live next to it in `.backup/<timestamp>/`.)
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { getConfigDir } from "./paths";
import { configRegistry, type ConfigName } from "./registry";

/** `<user config dir>/.backup/editor`. */
export function editorBackupRoot(): string {
  return path.join(getConfigDir(), ".backup", "editor");
}

/** File-name safe UTC time with milliseconds (two saves within a second must not share a directory). */
function stamp(now: Date): string {
  return `${now.toISOString().replace(/:/g, "-").replace(".", "-")}`;
}

async function readDirs(root: string): Promise<string[]> {
  try {
    return (await fsp.readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Copy `text` (the file as it is now) into a new backup directory and drop this file's copies beyond the newest `keep`. Returns the backup's path. */
export async function backupConfigText(name: ConfigName, text: string, keep: number, now: Date = new Date()): Promise<string> {
  const file = configRegistry[name].file;
  const root = editorBackupRoot();
  const target = path.join(root, stamp(now), file);
  await fsp.mkdir(/*turbopackIgnore: true*/ path.dirname(target), { recursive: true });
  // owner-only, like the file it copies (write.ts CONFIG_FILE_MODE)
  await fsp.writeFile(/*turbopackIgnore: true*/ target, text, { encoding: "utf8", mode: 0o600 });
  await pruneBackups(file, keep);
  return target;
}

/** Remove the oldest copies of `file` so that at most `keep` remain (empty directories go too). */
async function pruneBackups(file: string, keep: number): Promise<void> {
  const root = editorBackupRoot();
  const dirs = (await readDirs(root)).sort();
  const holding: string[] = [];
  for (const dir of dirs) {
    try {
      await fsp.access(path.join(/*turbopackIgnore: true*/ root, dir, file));
      holding.push(dir);
    } catch {
      // this backup holds other files
    }
  }
  for (const dir of holding.slice(0, Math.max(0, holding.length - keep))) {
    await fsp.rm(path.join(/*turbopackIgnore: true*/ root, dir, file), { force: true });
    try {
      await fsp.rmdir(path.join(/*turbopackIgnore: true*/ root, dir));
    } catch {
      // not empty: another file's copy is in it
    }
  }
}
