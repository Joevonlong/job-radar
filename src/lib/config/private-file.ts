/** Owner-only copies of shipped files into the user's directories (config, profile). Server / Node only. */
import fs from "node:fs";
import fsp from "node:fs/promises";

/**
 * Copy `source` to `target` unless `target` exists; true when it copied. The file is created with mode 0600 and then
 * filled, so it is never readable by others, not even for a moment (`copyFile` would take the source's 0644 first);
 * a chmod afterwards also covers a umask that took bits away. Throws on anything but "already exists".
 */
export async function copyPrivateIfMissing(source: string, target: string): Promise<boolean> {
  const content = await fsp.readFile(/*turbopackIgnore: true*/ source);
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(/*turbopackIgnore: true*/ target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") return false;
    throw err;
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content);
    await handle.close();
  } catch (err) {
    // a half-written file must not stay behind: the next run would take it for the user's own and keep it
    await handle.close().catch(() => undefined);
    await fsp.rm(/*turbopackIgnore: true*/ target, { force: true }).catch(() => undefined);
    throw err;
  }
  return true;
}
