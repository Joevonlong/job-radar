import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { writeConfigArchive, type ConfigArchiveDirs } from "./config-archive";
import {
  configArchiveName,
  formatBackupName,
  orphanConfigArchives,
  parseBackupName,
  planRetention,
  planSystemRetention,
  type RetentionPolicy,
} from "./retention";

/** First bytes of a pg_dump custom-format archive. */
const CUSTOM_FORMAT_MAGIC = "PGDMP";
const STDERR_TAIL_CHARS = 300;
const PARTIAL_SUFFIX = ".partial";
const PG_CONNECT_TIMEOUT_SECONDS = "10";
/** Backups hold the whole database: owner read/write only. */
const BACKUP_FILE_MODE = 0o600;
/** `pg_restore --list` only reads the archive's table of contents; this bounds a hung validator. */
const VALIDATE_TIMEOUT_MS = 120_000;

export type BackupErrorCode = "invalid_url" | "start_failed" | "pg_dump_failed" | "timeout" | "aborted" | "invalid_output" | "io";

/** A failed backup. The message never contains the connection URL or the password. */
export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: BackupErrorCode,
  ) {
    super(message);
    this.name = "BackupError";
  }
}

export interface PgConnection {
  host: string;
  port: string;
  user: string;
  database: string;
  password: string | null;
}

/** Split a `postgres://` URL into the parts pg_dump takes, so the password goes in the environment, not argv. */
export function parsePgConnection(databaseUrl: string): PgConnection {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new BackupError("DATABASE_URL is not a valid URL", "invalid_url");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new BackupError("DATABASE_URL must be a postgres:// URL", "invalid_url");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database === "") throw new BackupError("DATABASE_URL has no database name", "invalid_url");
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    database,
    password: url.password ? decodeURIComponent(url.password) : null,
  };
}

/**
 * pg_dump arguments: custom format (compressed, restorable table by table with pg_restore), no owner
 * or ACL statements so the dump restores under any role. The dump goes to stdout.
 */
export function pgDumpArgs(connection: PgConnection): string[] {
  const args = ["--format=custom", "--no-owner", "--no-acl", "--host", connection.host, "--port", connection.port];
  if (connection.user !== "") args.push("--username", connection.user);
  args.push("--no-password", "--dbname", connection.database);
  return args;
}

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: Date;
  /** The `.config.tgz` of the same backup sits next to the dump. */
  hasConfig: boolean;
}

/** Scheduled backups in `directory` (files named like `jobradar-YYYYMMDD-HHMMSS.dump`), newest name first. */
export async function listBackups(directory: string): Promise<BackupFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: BackupFile[] = [];
  for (const name of names) {
    const parsed = parseBackupName(name);
    if (!parsed) continue;
    const file = path.join(directory, name);
    const info = await stat(file);
    if (!info.isFile()) continue;
    const config = await stat(path.join(directory, configArchiveName(name))).catch(() => null);
    files.push({ name, path: file, bytes: info.size, modifiedAt: info.mtime, hasConfig: config?.isFile() === true });
  }
  return files.sort((a, b) => b.name.localeCompare(a.name));
}

async function removeFile(file: string): Promise<boolean> {
  try {
    await rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the backups the policy no longer keeps, each with its `.config.tgz`, and any scheduled `.config.tgz` whose dump
 * is gone. Returns what was removed and what could not be.
 */
export async function applyRetention(
  directory: string,
  policy: RetentionPolicy,
): Promise<{ kept: string[]; removed: string[]; failed: string[] }> {
  const names = (await listBackups(directory)).map((file) => file.name);
  const plan = planRetention(names, policy);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of plan.remove) {
    if (await removeFile(path.join(directory, name))) {
      removed.push(name);
      await removeFile(path.join(directory, configArchiveName(name)));
    } else {
      failed.push(name);
    }
  }
  const present = await readdir(directory).catch(() => [] as string[]);
  for (const orphan of orphanConfigArchives(present)) await removeFile(path.join(directory, orphan));
  return { kept: plan.keep, removed, failed };
}

/**
 * Keep only the newest `keep` safety backups of each kind (`pre-deploy`, `pre-restore`, `premigrate`), with their
 * `.config.tgz`. Manual backups without such a label are never touched.
 */
export async function applySystemRetention(directory: string, keep: number): Promise<{ removed: string[]; failed: string[] }> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".dump"));
  const plan = planSystemRetention(names, keep);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of plan.remove) {
    if (await removeFile(path.join(directory, name))) {
      removed.push(name);
      await removeFile(path.join(directory, configArchiveName(name)));
    } else {
      failed.push(name);
    }
  }
  return { removed, failed };
}

export interface RunBackupOptions {
  /** Where the dump goes; created when missing. */
  directory: string;
  databaseUrl: string;
  /** The time zone the file name's wall clock is in (schedule.yaml `timezone`). */
  timeZone: string;
  policy: RetentionPolicy;
  timeoutMs: number;
  /** The pg_dump command plus any leading arguments (default `["pg_dump"]`). Connection flags are appended. */
  pgDump?: readonly string[];
  /** The pg_restore command used to validate the finished archive (default `["pg_restore"]`); the archive is fed on stdin. */
  pgRestore?: readonly string[];
  /** Opens the destination file (default: a 0600 file stream). Tests inject a failing stream here. */
  createDestination?: (file: string) => Writable;
  /** Dump file name inside `directory` (default: the scheduled `jobradar-YYYYMMDD-HHMMSS.dump`). */
  fileName?: string;
  /** Apply the daily / weekly retention after the backup (default true; the pre-migration backup turns it off). */
  applyRetention?: boolean;
  /**
   * Also archive the user's config and profile as `<dump name>.config.tgz` (default: no). A failing archive never fails the
   * backup (the dump is complete); it is reported in `BackupResult.configWarning`.
   */
  configArchive?: { dirs: ConfigArchiveDirs; createDestination?: (file: string) => Writable } | null;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface BackupResult {
  /** File name inside `directory`. */
  file: string;
  path: string;
  bytes: number;
  durationMs: number;
  /** Older backups deleted by the retention policy. */
  removed: string[];
  /** Backups the policy wanted to delete but could not. */
  removeFailed: string[];
  /** File name of the `.config.tgz` written next to the dump, or null (not asked for, or it failed: see `configWarning`). */
  configFile: string | null;
  /** Why the config archive is missing although it was asked for; null otherwise. */
  configWarning: string | null;
}

async function hasCustomFormatHeader(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(CUSTOM_FORMAT_MAGIC.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.toString("latin1") === CUSTOM_FORMAT_MAGIC;
  } finally {
    await handle.close();
  }
}

/** Run `pg_restore --list` on the archive: it parses the whole table of contents, so a truncated or corrupt file fails. */
async function validateArchive(file: string, command: readonly string[]): Promise<void> {
  const [bin, ...leading] = command;
  if (!bin) throw new BackupError("pg_restore command is empty", "start_failed");
  const child = spawn(bin, [...leading, "--list"], { stdio: ["pipe", "ignore", "pipe"] });
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });
  const outcome = new Promise<{ code: number | null; spawnError: NodeJS.ErrnoException | null }>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => resolve({ code: null, spawnError: error }));
    child.once("close", (code) => resolve({ code, spawnError: null }));
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), VALIDATE_TIMEOUT_MS);
  // The validator may exit before reading everything (error); the resulting EPIPE is reported through its exit code.
  child.stdin.on("error", () => undefined);
  await pipeline(createReadStream(file), child.stdin).catch(() => undefined);
  const { code, spawnError } = await outcome;
  clearTimeout(timer);
  if (spawnError) throw new BackupError(`could not start pg_restore to validate the backup (${spawnError.code ?? "error"})`, "start_failed");
  if (code !== 0) {
    throw new BackupError(`the backup failed validation (pg_restore --list exited with code ${code ?? "null"}): ${stderrTail.trim() || "no output"}`, "invalid_output");
  }
}

/** Flush the file's data to disk before it is renamed into place. */
async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Dump the database to `<directory>/jobradar-YYYYMMDD-HHMMSS.dump`, then apply the retention policy.
 * The dump is written (mode 0600) to a `.partial` file and renamed only after pg_dump exited 0, every byte was
 * written, the file was fsynced and `pg_restore --list` accepted it, so a crash, a full disk or a failed run never
 * leaves something that looks like a backup. Retention runs only after that.
 * Throws BackupError.
 */
export async function runBackup(options: RunBackupOptions): Promise<BackupResult> {
  const now = options.now ?? (() => new Date());
  const startedMs = Date.now();
  const connection = parsePgConnection(options.databaseUrl);
  const [command, ...leading] = options.pgDump ?? ["pg_dump"];
  const pgRestore = options.pgRestore ?? ["pg_restore"];
  if (!command) throw new BackupError("pg_dump command is empty", "start_failed");

  try {
    await mkdir(options.directory, { recursive: true });
  } catch (error) {
    throw new BackupError(`cannot create the backup directory: ${(error as NodeJS.ErrnoException).code ?? "error"}`, "io");
  }
  const name = options.fileName ?? formatBackupName(now(), options.timeZone);
  if (name !== path.basename(name) || !name.endsWith(".dump")) throw new BackupError("invalid backup file name", "io");
  const finalPath = path.join(options.directory, name);
  const partialPath = `${finalPath}${PARTIAL_SUFFIX}`;

  let timedOut = false;
  let stderrTail = "";
  const child = spawn(command, [...leading, ...pgDumpArgs(connection)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(connection.password === null ? {} : { PGPASSWORD: connection.password }),
      PGCONNECT_TIMEOUT: PG_CONNECT_TIMEOUT_SECONDS,
    },
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });

  const exited = new Promise<{ code: number | null; spawnError: NodeJS.ErrnoException | null }>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => resolve({ code: null, spawnError: error }));
    child.once("close", (code) => resolve({ code, spawnError: null }));
  });
  const kill = (): void => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  options.signal?.addEventListener("abort", kill, { once: true });
  if (options.signal?.aborted) kill();

  const openDestination = options.createDestination ?? ((file: string) => createWriteStream(file, { mode: BACKUP_FILE_MODE }));
  const cleanup = async (): Promise<void> => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
    await rm(partialPath, { force: true });
  };

  try {
    await rm(partialPath, { force: true });
    // A write error must fail the backup: stop pg_dump, and report it once pg_dump is gone.
    const copied = pipeline(child.stdout, openDestination(partialPath)).then(
      () => null,
      (error: unknown) => {
        kill();
        return error;
      },
    );
    const { code, spawnError } = await exited;
    const writeError = await copied;

    if (spawnError) throw new BackupError(`could not start pg_dump (${spawnError.code ?? "error"})`, "start_failed");
    if (timedOut) throw new BackupError(`pg_dump did not finish within ${Math.round(options.timeoutMs / 1000)} s`, "timeout");
    if (options.signal?.aborted) throw new BackupError("backup aborted", "aborted");
    if (writeError !== null) {
      throw new BackupError(`could not write the backup: ${(writeError as NodeJS.ErrnoException).code ?? "write error"}`, "io");
    }
    if (code !== 0) {
      throw new BackupError(`pg_dump exited with code ${code ?? "null"}: ${stderrTail.trim() || "no output"}`, "pg_dump_failed");
    }

    const info = await stat(partialPath).catch(() => null);
    if (!info || info.size === 0) throw new BackupError("pg_dump produced an empty file", "invalid_output");
    if (!(await hasCustomFormatHeader(partialPath))) throw new BackupError("pg_dump output is not a custom-format archive", "invalid_output");

    await chmod(partialPath, BACKUP_FILE_MODE);
    await fsyncFile(partialPath);
    await validateArchive(partialPath, pgRestore);

    await rename(partialPath, finalPath);
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);

    // The dump is safe on disk. The config archive and retention can only add warnings, never fail the run.
    let configFile: string | null = null;
    let configWarning: string | null = null;
    if (options.configArchive) {
      const archiveName = configArchiveName(name);
      try {
        await writeConfigArchive({
          dirs: options.configArchive.dirs,
          destination: path.join(options.directory, archiveName),
          createDestination: options.configArchive.createDestination,
        });
        configFile = archiveName;
      } catch (error) {
        configWarning = error instanceof Error ? error.message : "could not write the config archive";
      }
    }
    const retention =
      options.applyRetention === false
        ? { kept: [], removed: [], failed: [] }
        : await applyRetention(options.directory, options.policy).catch(() => ({ kept: [], removed: [], failed: [] }));
    return {
      file: name,
      path: finalPath,
      bytes: info.size,
      durationMs: Date.now() - startedMs,
      removed: retention.removed,
      removeFailed: retention.failed,
      configFile,
      configWarning,
    };
  } catch (error) {
    await cleanup();
    if (error instanceof BackupError) throw error;
    throw new BackupError(`backup failed: ${(error as NodeJS.ErrnoException).code ?? "unexpected error"}`, "io");
  }
}

