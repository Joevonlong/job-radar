/** Owner-only copies of shipped files into the user's directories (config, profile). Server / Node only. */
import fs from "node:fs";
import fsp from "node:fs/promises";

import { commitConfigFile } from "./atomic";
import { withConfigWriteLock } from "./write-lock";

/**
 * Copy `source` to `target` unless `target` exists; true when it copied. The file is owner-only from its first byte
 * (`copyFile` would take the source's 0644 first). Never replaces. Nothing to copy needs neither the lock nor the database.
 */
export async function copyPrivateIfMissing(source: string, target: string): Promise<boolean> {
  if (fs.existsSync(/*turbopackIgnore: true*/ target)) return false;
  const content = await fsp.readFile(/*turbopackIgnore: true*/ source);
  return withConfigWriteLock(async () => (await commitConfigFile(target, content, { mode: "create" })) === "written", target);
}
