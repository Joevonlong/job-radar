/**
 * The one way a file of the user's config or profile directory is committed. Order: temp file in the same directory
 * (mode 0600 from the first byte) -> read back -> read the target again and compare with the base -> ownership check ->
 * publish. Server / Node only.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "./errors";
import { readUserFile } from "./read-user-file";
import { currentConfigWriteLock, isLockedConfigPath, lockLostError, lockTestPause } from "./write-lock";

/**
 * Mode of every config / profile file the app writes: owner read / write only. The config files can name
 * credential files, proxies with passwords and the profile holds personal data. On Linux the web and the runner run as
 * the same uid (compose `PUID` / `PGID`), and the host processes run as the owner of `data/`.
 */
export const CONFIG_FILE_MODE = 0o600;

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface CommitOptions {
  /** The sha256 the target must still have (null: it must not exist). Absent: not compared. */
  baseSha256?: string | null;
  /** A further synchronous check of the target right before the ownership check; a throw leaves the file as it was. */
  checkFresh?: () => void;
  /** Runs on the completed temp file's text; a throw leaves the file as it was. */
  verify?: (content: Buffer) => void | Promise<void>;
  /** `create`: never replace; an existing target is left alone and the result is "existed". */
  mode?: "replace" | "create";
}

function stale(file: string): ConfigError {
  return new ConfigError({ configName: path.basename(file), filePath: file, kind: "stale" });
}

function targetSha256(file: string): string | null {
  try {
    return sha256(readUserFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Publish `tmp` as `target` without ever replacing it (link + unlink; Node has no `renameat2`). False when `target`
 * already exists; the temp file is gone either way.
 */
export function publishNoReplace(tmp: string, target: string): boolean {
  try {
    fs.linkSync(/*turbopackIgnore: true*/ tmp, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    fs.rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
  }
}

/**
 * Commit one file. Under the user config or profile directory this must run inside `withConfigWriteLock`: a writer that
 * forgot the lock fails here (and so in its tests). Readers never see a partial file. Throws ConfigError `stale` (the
 * target is not the base) or `busy` (the lock's session is gone).
 */
export async function commitConfigFile(file: string, content: string | Buffer, options: CommitOptions = {}): Promise<"written" | "existed"> {
  const lock = currentConfigWriteLock();
  if (lock === null && isLockedConfigPath(file)) throw new Error(`config file written outside the config write lock: ${path.basename(file)}`);
  const dir = path.dirname(file);
  await fsp.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const handle = await fsp.open(/*turbopackIgnore: true*/ tmp, "wx", CONFIG_FILE_MODE);
    try {
      // the umask can only take bits away; chmod makes 0600 exact even under an unusual umask
      await handle.chmod(CONFIG_FILE_MODE);
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const written = await fsp.readFile(/*turbopackIgnore: true*/ tmp);
    if (!written.equals(Buffer.from(content))) throw new Error(`config file did not read back as written: ${path.basename(file)}`);
    await options.verify?.(written);

    if (options.baseSha256 !== undefined && targetSha256(file) !== options.baseSha256) throw stale(file);
    options.checkFresh?.();
    await lockTestPause("after-hash-check");
    if (lock !== null && !(await lock.fence())) throw lockLostError(file);
    await lockTestPause("after-fence");
    await lockTestPause("before-publish");
    if (options.mode === "create") return publishNoReplace(tmp, file) ? "written" : "existed";
    fs.renameSync(/*turbopackIgnore: true*/ tmp, file);
    return "written";
  } catch (error) {
    await fsp.rm(/*turbopackIgnore: true*/ tmp, { force: true });
    throw error;
  }
}
