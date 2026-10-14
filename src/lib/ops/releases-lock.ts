/**
 * The release lock `data/releases/ai-worker/.lock` as `pnpm run doctor` reads it: the owner and the in-flight records.
 * The same formats and rules as `scripts/ops/lib/releases.sh` (`releases_lock_owner_read`, `releases_inflight_list`,
 * `releases_pid_alive`); the tests read the same fixtures with both. Reads only: the doctor never takes, changes or
 * clears the lock, and never shows the owner's token.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** The command that finds what a killed deploy left running (`RELEASES_PS_COMMAND` in releases.sh, printed verbatim). */
export const RELEASES_PS_COMMAND =
  "ps -A -o pid,ppid,pgid,etime,command | grep -E '[d]ocker compose|[p]npm|[m]igrate|[c]onfig[:-]|[o]ps:drain|[p]repare-release|[i]nstall-ai-worker|[l]aunchctl|[s]ystemctl'";

export interface ReleasesLockOwner {
  token: string;
  pid: number;
  host: string;
  /** Unix seconds. */
  started: number;
}

export type InflightEntry =
  | { name: string; kind: "record"; script: string; pid: number; started: number; alive: boolean }
  | { name: string; kind: "partial" }
  | { name: string; kind: "unreadable" };

export type ReleasesLockState = { present: false; lockDir: string } | { present: true; lockDir: string; owner: ReleasesLockOwner | null; records: InflightEntry[] };

export const releasesLockDir = (main: string): string => path.join(main, "data", "releases", "ai-worker", ".lock");

/** Lines as `while read` sees them: a final line without a newline still counts, a final newline adds nothing. */
const lines = (text: string): string[] => {
  const parts = text.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
};

/** The owner file: exactly four lines in order (token, pid, host, started), else null. */
export function parseLockOwner(text: string): ReleasesLockOwner | null {
  const l = lines(text);
  if (l.length !== 4) return null;
  const token = /^token=([0-9a-f]{32})$/.exec(l[0] ?? "")?.[1];
  const pid = /^pid=([0-9]+)$/.exec(l[1] ?? "")?.[1];
  const host = /^host=(\S+)$/.exec(l[2] ?? "")?.[1];
  const started = /^started=([0-9]+)$/.exec(l[3] ?? "")?.[1];
  if (token === undefined || pid === undefined || host === undefined || started === undefined) return null;
  return { token, pid: Number(pid), host, started: Number(started) };
}

/**
 * An in-flight record, read as `releases_inflight_list` reads it: trailing newlines dropped (command substitution), three
 * lines, the first `script=<name>`, and the first `pid=` / `started=` lines all digits. Else null.
 */
export function parseInflightRecord(text: string): { script: string; pid: number; started: number } | null {
  const l = text.replace(/\n+$/, "").split("\n");
  if (l.length !== 3) return null;
  const field = (key: string): string | undefined => l.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const script = field("script");
  const pid = field("pid");
  const started = field("started");
  if (script === undefined || l[0] !== `script=${script}` || !/^[A-Za-z0-9._-]+$/.test(script)) return null;
  if (pid === undefined || !/^[0-9]+$/.test(pid) || started === undefined || !/^[0-9]+$/.test(started)) return null;
  return { script, pid: Number(pid), started: Number(started) };
}

/** False only when the process is certainly gone (ESRCH); another user's process (EPERM) counts as alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A regular file's text (not through a symbolic link), or null. */
async function regularText(file: string): Promise<string | null> {
  try {
    if (!(await lstat(file)).isFile()) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Read the lock under `main` (the production checkout). Never throws: what cannot be read is reported as unreadable. */
export async function readReleasesLock(main: string, alive: (pid: number) => boolean = pidAlive): Promise<ReleasesLockState> {
  const lockDir = releasesLockDir(main);
  try {
    await lstat(lockDir);
  } catch {
    return { present: false, lockDir };
  }
  const ownerText = await regularText(path.join(lockDir, "owner"));
  const owner = ownerText === null ? null : parseLockOwner(ownerText);
  let names: string[] = [];
  try {
    names = await readdir(path.join(lockDir, "inflight"));
  } catch {
    names = [];
  }
  const records: InflightEntry[] = [];
  for (const name of [...names].sort()) {
    if (name.startsWith(".tmp-")) {
      records.push({ name, kind: "partial" });
      continue;
    }
    const text = await regularText(path.join(lockDir, "inflight", name));
    const record = text === null ? null : parseInflightRecord(text);
    records.push(record === null ? { name, kind: "unreadable" } : { name, kind: "record", ...record, alive: alive(record.pid) });
  }
  return { present: true, lockDir, owner, records };
}
