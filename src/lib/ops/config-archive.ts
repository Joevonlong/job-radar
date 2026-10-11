import { chmod, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { type Writable } from "node:stream";

import { readTarGz, writeTarGz, type TarFile } from "./tar";

const PARTIAL_SUFFIX = ".partial";
const ARCHIVE_FILE_MODE = 0o600;

/** Where the user's config and profile live (the app's `data/config` and `data/profile`; in the container /app/data/...). */
export interface ConfigArchiveDirs {
  config: string;
  profile: string;
}

/** Archive member roots: the same layout as scripts/ops/backup.sh, so `tar -xzf <file> -C <app root>` puts them back. */
export const CONFIG_MEMBER_ROOT = "data/config";
export const PROFILE_MEMBER_ROOT = "data/profile";

/** Directory names never archived: the config migrator's originals. */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([".backup"]);
/** File names never archived: secrets that can be re-created (the web session secret signs login cookies). */
const EXCLUDED_FILES: ReadonlySet<string> = new Set([".web-session-secret"]);

export class ConfigArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigArchiveError";
  }
}

interface Candidate {
  member: string;
  file: string;
  mode: number;
  mtime: number;
}

async function walk(dir: string, memberRoot: string, out: Candidate[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // a fresh install may have no profile yet
    throw error;
  }
  for (const name of entries.sort()) {
    const file = path.join(dir, name);
    const member = `${memberRoot}/${name}`;
    const info = await lstat(file).catch(() => null);
    if (info === null || info.isSymbolicLink()) continue; // symlinks could point anywhere: never followed
    if (info.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(name)) await walk(file, member, out);
    } else if (info.isFile() && !EXCLUDED_FILES.has(name) && !name.endsWith(PARTIAL_SUFFIX)) {
      out.push({ member, file, mode: info.mode & 0o777, mtime: Math.floor(info.mtimeMs / 1000) });
    }
  }
}

/** The members the archive will hold, sorted by name. */
export async function listArchiveMembers(dirs: ConfigArchiveDirs): Promise<string[]> {
  const candidates: Candidate[] = [];
  await walk(dirs.config, CONFIG_MEMBER_ROOT, candidates);
  await walk(dirs.profile, PROFILE_MEMBER_ROOT, candidates);
  return candidates.map((c) => c.member);
}

async function* readFiles(candidates: readonly Candidate[]): AsyncGenerator<TarFile> {
  for (const candidate of candidates) {
    // A file that vanished between listing and reading is skipped: the archive is a snapshot of what is there.
    const data = await readFile(candidate.file).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (data !== null) yield { name: candidate.member, data, mode: candidate.mode, mtime: candidate.mtime };
  }
}

export interface WriteConfigArchiveOptions {
  dirs: ConfigArchiveDirs;
  /** Final path of the `.config.tgz`; written as `<destination>.partial` first. */
  destination: string;
  /** Opens the destination file (default: a 0600 file stream). Tests inject a failing stream here. */
  createDestination?: (file: string) => Writable;
}

export interface ConfigArchiveResult {
  path: string;
  bytes: number;
  members: number;
}

/**
 * Write `data/config` and `data/profile` (without `.backup/`, `.web-session-secret` and symlinks) as a gzip tar, using the
 * same `.partial` -> fsync -> 0600 -> rename steps as the dump, then read it back (gunzip, count the members) so a bad
 * archive is reported now, not at restore time. Throws ConfigArchiveError; nothing is left behind on failure.
 */
export async function writeConfigArchive(options: WriteConfigArchiveOptions): Promise<ConfigArchiveResult> {
  const partial = `${options.destination}${PARTIAL_SUFFIX}`;
  const openDestination = options.createDestination ?? ((file: string) => createWriteStream(file, { mode: ARCHIVE_FILE_MODE }));
  try {
    const candidates: Candidate[] = [];
    await walk(options.dirs.config, CONFIG_MEMBER_ROOT, candidates);
    await walk(options.dirs.profile, PROFILE_MEMBER_ROOT, candidates);
    if (candidates.length === 0) throw new ConfigArchiveError("there is no config or profile file to archive");

    await rm(partial, { force: true });
    const files: TarFile[] = [];
    for await (const file of readFiles(candidates)) files.push(file);
    await writeTarGz(files, openDestination(partial));

    await chmod(partial, ARCHIVE_FILE_MODE);
    const handle = await open(partial, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const stored = await readFile(partial);
    const members = await readTarGz(stored);
    if (members.length !== files.length) throw new ConfigArchiveError("the written archive does not hold every file");
    await rename(partial, options.destination);
    return { path: options.destination, bytes: stored.length, members: members.length };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    if (error instanceof ConfigArchiveError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigArchiveError(`could not write the config archive${code ? ` (${code})` : ""}: ${error instanceof Error ? error.name : "error"}`);
  }
}
