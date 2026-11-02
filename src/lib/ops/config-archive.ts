import { chmod, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { createWriteStream, readFileSync } from "node:fs";
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
/**
 * The marker every archive carries: what a missing setup.yaml means in it. An archive without one predates the wizard's
 * semantics, and restoring it keeps that install out of the wizard. `scripts/ops/lib/existing-install.sh` holds the same
 * name, value and text (a test compares them).
 */
export const ARCHIVE_META_NAME = ".archive-meta.yaml";
export const ARCHIVE_SETUP_SEMANTICS = 2;
export const ARCHIVE_META_YAML = `# Written by the backup into the config archive (docs/backup-restore.md). Not a config file.
# setup_semantics 2: a missing setup.yaml means the setup wizard is pending.
archive_meta_version: 1
setup_semantics: ${ARCHIVE_SETUP_SEMANTICS}
`;
const ARCHIVE_META_MEMBER = `${CONFIG_MEMBER_ROOT}/${ARCHIVE_META_NAME}`;

/**
 * File names never archived: secrets that can be re-created, the generated marker (only the generated one goes in), and
 * coordination files that earlier versions may have left behind.
 */
const EXCLUDED_FILES: ReadonlySet<string> = new Set([".web-session-secret", ARCHIVE_META_NAME, ".upgrade-freeze", ".write.lock"]);

/** `setup_semantics` of an unpacked archive's config directory: its value, "none" without a marker, "unreadable" otherwise. */
export function readArchiveSetupSemantics(dir: string): number | "none" | "unreadable" {
  let text: string;
  try {
    text = readFileSync(/*turbopackIgnore: true*/ path.join(dir, ARCHIVE_META_NAME), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unreadable";
  }
  const match = /^setup_semantics: ([0-9]+)$/m.exec(text);
  return match?.[1] === undefined ? "unreadable" : Number(match[1]);
}

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
    if (name === ".write.lock.guard" || name.startsWith(".write.lock.guard.")) continue;
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
  return [...candidates.map((c) => c.member), ARCHIVE_META_MEMBER];
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
 * Write `data/config` and `data/profile` (without `.backup/`, `.web-session-secret` and symlinks) plus the generated marker as a gzip tar, using the
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
    files.push({ name: ARCHIVE_META_MEMBER, data: Buffer.from(ARCHIVE_META_YAML), mode: ARCHIVE_FILE_MODE, mtime: Math.floor(Date.now() / 1000) });
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
    const markers = members.filter((member) => member.name === ARCHIVE_META_MEMBER);
    if (markers.length !== 1 || !/^setup_semantics: [0-9]+$/m.test(markers[0]?.data.toString("utf8") ?? "")) throw new ConfigArchiveError("the written archive has no readable marker");
    await rename(partial, options.destination);
    return { path: options.destination, bytes: stored.length, members: members.length };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    if (error instanceof ConfigArchiveError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigArchiveError(`could not write the config archive${code ? ` (${code})` : ""}: ${error instanceof Error ? error.name : "error"}`);
  }
}
