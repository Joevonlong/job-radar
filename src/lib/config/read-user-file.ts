/**
 * Read a file of the user's config or profile directory, which may be replaced at any moment by another process.
 *
 * On Docker Desktop a bind mount can answer ENOENT from open for about a second after the host renamed over a file the
 * container has looked at before: the kernel in the VM still points at the replaced inode. `stat` is right meanwhile (the
 * entry is there), and listing the directory usually refreshes the entry. Taking that ENOENT for "no such file" would
 * make a writer start from the defaults, so an ENOENT only counts while the entry is really absent. A file that does not
 * come back in time is an error other than ENOENT: nothing goes on as if the file were missing.
 *
 * `scripts/dev/config-lock-mount-drill.sh` runs this file in a container and on the Mac, so it imports Node's modules
 * only and keeps to syntax Node can strip. Server / Node only.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Longer than the longest time seen (about 1.3 s on a loaded Mac). A constant, not configuration: config files are read
 * through here, and the wait only matters when the mount misbehaves.
 */
const SETTLE_LIMIT_MS = 5000;
const RETRY_PAUSE_MS = 10;

const pause = new Int32Array(new SharedArrayBuffer(4));

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Throws ENOENT only when the file is really absent. `onGap` (the mount drill) gets the time a late file took. */
export function readUserFile(file: string, onGap?: (waitedMs: number) => void): Buffer {
  const started = Date.now();
  let gap = false;
  for (;;) {
    try {
      const content = fs.readFileSync(/*turbopackIgnore: true*/ file);
      if (gap) onGap?.(Date.now() - started);
      return content;
    } catch (error) {
      if (!isEnoent(error) || !fs.existsSync(/*turbopackIgnore: true*/ file)) throw error;
    }
    if (Date.now() - started > SETTLE_LIMIT_MS) {
      throw Object.assign(new Error(`${path.basename(file)} exists but could not be opened for ${SETTLE_LIMIT_MS} ms`), { code: "EAGAIN" });
    }
    try {
      fs.readdirSync(/*turbopackIgnore: true*/ path.dirname(file));
    } catch {
      // only a way to refresh the entry; the next read decides
    }
    if (gap) Atomics.wait(pause, 0, 0, RETRY_PAUSE_MS);
    gap = true;
  }
}

/** `readUserFile` as UTF-8 text. */
export function readUserText(file: string): string {
  return readUserFile(file).toString("utf8");
}
