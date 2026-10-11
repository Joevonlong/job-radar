/**
 * The ai-worker's own log files. launchd cannot open a file on the external volume (a plist whose StandardOutPath /
 * StandardErrorPath points there fails to start with `last exit code = 78: EX_CONFIG`), but the node process it starts can
 * write there. So the plist keeps launchd's capture file on the internal disk, and the worker sends its stdout / stderr to
 * `data/logs/` itself and rotates them by size, together with launchd's capture file (which only catches what is
 * printed before the files are open, and crashes; its rotated copies go to the external volume too).
 */
import fs from "node:fs";
import path from "node:path";

/** The worker's log files inside `--log-dir`. */
export const AI_WORKER_LOG_NAMES = { out: "ai-worker.out.log", err: "ai-worker.err.log" } as const;
/** `--log-dir` as scripts/ops/install-ai-worker.sh sets it, relative to the app root (the project directory; `data/` is gitignored). */
export const AI_WORKER_LOG_DIR = "data/logs";
/** launchd's own capture file (scripts/ops/install-ai-worker.sh), as messages show it. */
export const AI_WORKER_LAUNCHD_LOG = "~/Library/Logs/job-radar/ai-worker.launchd.log";

/** Remove `<copy>.N` copies with N above `keep` (left over from a larger `log_keep`). */
function removeExtraCopies(copy: string, keep: number): void {
  const base = path.basename(copy);
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(copy));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.`)) continue;
    const suffix = name.slice(base.length + 1);
    if (/^\d+$/.test(suffix) && Number(suffix) > keep) fs.rmSync(path.join(path.dirname(copy), name), { force: true });
  }
}

/**
 * Copy-truncate rotation. When `file` is larger than `maxBytes`: `.1` … `.keep-1` move up by one, the file is copied to `.1`
 * and emptied in place, so a writer that holds it open in append mode (launchd, this process) simply carries on at the start.
 * Copies above `keep` are removed; `keep` 0 only empties the file. `archiveDir` puts the copies elsewhere (launchd's capture
 * file lives on the nearly full internal disk; its copies go to the external volume). Returns true when it rotated; a
 * missing file is not an error.
 */
export function rotateLogFile(file: string, maxBytes: number, keep: number, archiveDir?: string): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  const copy = path.join(archiveDir ?? path.dirname(file), path.basename(file));
  removeExtraCopies(copy, keep);
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = `${copy}.${index}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${copy}.${index + 1}`);
  }
  if (keep >= 1) fs.copyFileSync(file, `${copy}.1`);
  fs.truncateSync(file, 0);
  return true;
}

export interface FileOutput {
  /** Where stdout and stderr go now. */
  readonly files: { out: string; err: string };
  /** The directory both files are in (`--log-dir`). */
  readonly dir: string;
  /** Rotate both files by size (`rotateLogFile`); returns the files that were rotated. */
  rotate(maxBytes: number, keep: number): string[];
  /** Put the streams back and close the files. */
  restore(): void;
}

type OutputStream = Pick<NodeJS.WriteStream, "write">;

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
}

/** Replace `stream.write` with a synchronous append to `fd`; a failing append (the volume went away) falls back to the original stream. */
function divert(stream: OutputStream, fd: number): () => void {
  const original = stream.write;
  const write = (...args: unknown[]): boolean => {
    const [chunk, encoding, callback] = args;
    const done = typeof encoding === "function" ? encoding : typeof callback === "function" ? callback : undefined;
    try {
      const data = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8") : chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
      writeAll(fd, data);
    } catch {
      return Reflect.apply(original, stream, args) as boolean;
    }
    if (done !== undefined) process.nextTick(() => (done as (error?: Error | null) => void)(null));
    return true;
  };
  stream.write = write as OutputStream["write"];
  return () => {
    stream.write = original;
  };
}

/**
 * Send everything written to stdout / stderr to `<dir>/ai-worker.{out,err}.log`: appended synchronously, so a crash loses
 * nothing and a rotation never races a write. Throws when the directory or a file cannot be opened (the caller then keeps
 * the plain streams, which launchd captures).
 */
export function redirectOutputToFiles(dir: string, streams: { stdout: OutputStream; stderr: OutputStream } = { stdout: process.stdout, stderr: process.stderr }): FileOutput {
  fs.mkdirSync(dir, { recursive: true });
  const files = { out: path.join(dir, AI_WORKER_LOG_NAMES.out), err: path.join(dir, AI_WORKER_LOG_NAMES.err) };
  const outFd = fs.openSync(files.out, "a");
  let errFd: number;
  try {
    errFd = fs.openSync(files.err, "a");
  } catch (error) {
    fs.closeSync(outFd);
    throw error;
  }
  const undo = [divert(streams.stdout, outFd), divert(streams.stderr, errFd)];
  return {
    files,
    dir,
    rotate: (maxBytes, keep) => [files.out, files.err].filter((file) => rotateLogFile(file, maxBytes, keep)),
    restore() {
      for (const step of undo) step();
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    },
  };
}
