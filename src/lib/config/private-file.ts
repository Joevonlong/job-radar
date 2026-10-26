/** Owner-only copies of shipped files into the user's directories (config, profile). Server / Node only. */
import fs from "node:fs";
import fsp from "node:fs/promises";

import { commitConfigWrite, withConfigWriteLock } from "./write-lock";

/**
 * Copy `source` to `target` unless `target` exists; true when it copied. The file is created with mode 0600 and then
 * filled, so it is never readable by others, not even for a moment (`copyFile` would take the source's 0644 first);
 * a chmod afterwards also covers a umask that took bits away. Throws on anything but "already exists".
 */
export async function copyPrivateIfMissing(source: string, target: string): Promise<boolean> {
  if (fs.existsSync(/*turbopackIgnore: true*/ target)) return false;
  return withConfigWriteLock(target, async () => {
    if (fs.existsSync(/*turbopackIgnore: true*/ target)) return false;
    const content = await fsp.readFile(/*turbopackIgnore: true*/ source);
    return commitConfigWrite(target, () => {
      let handle: number;
      try {
        handle = fs.openSync(/*turbopackIgnore: true*/ target, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      try {
        fs.fchmodSync(handle, 0o600);
        fs.writeFileSync(handle, content);
      } catch (error) {
        fs.rmSync(/*turbopackIgnore: true*/ target, { force: true });
        throw error;
      } finally {
        fs.closeSync(handle);
      }
      return true;
    });
  });
}
