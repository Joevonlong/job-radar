/**
 * Safety checks and fixed values shared by `scripts/demo-prepare.ts` and `playwright.shots.config.ts` (the README
 * screenshots). No side effects on import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every database the demo touches is named like this; anything else is refused, whatever the mode. */
export const DEMO_DB_PREFIX = "jobradar_demo";

/** Every directory the demo empties lies in a directory whose name starts with this. */
export const DEMO_DIR_PREFIX = "job-radar-demo";

/** The dashboard address the demo uses wherever a link to it is shown (the Telegram preview's "open details"). */
export const DEMO_BASE_URL = "http://127.0.0.1:3000";

/** The demo's local time zone (the seeded jobs are in Germany). */
export const DEMO_TIMEZONE = "Europe/Berlin";

/** The fixed local hour "now" is set to, so two runs on the same day produce the same data. */
export const DEMO_HOUR = 10;

export class DemoCheckError extends Error {}

/** Refuse a database name that is not a demo database (`jobradar_demo` followed by `[a-z0-9_]`). */
export function assertDemoDbName(name: string): string {
  if (!new RegExp(`^${DEMO_DB_PREFIX}[a-z0-9_]*$`).test(name)) {
    throw new DemoCheckError(`the demo database name must start with ${DEMO_DB_PREFIX} and contain only [a-z0-9_] (got "${name}")`);
  }
  return name;
}

/** The database name of a connection URL, checked. */
export function demoDbNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DemoCheckError("the demo database URL is not a valid URL");
  }
  return assertDemoDbName(decodeURIComponent(parsed.pathname.slice(1)));
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // a directory that does not exist yet: resolve its parent
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realpathOrSelf(parent), path.basename(p));
  }
}

/**
 * The temp directories the demo may use: `/tmp` where it exists (its path says nothing about the machine, unlike macOS's
 * per-user `os.tmpdir()`, and the settings page shows where it saves), and `os.tmpdir()`.
 */
export function tempRoots(): string[] {
  return [...new Set([...(process.platform !== "win32" && fs.existsSync("/tmp") ? ["/tmp"] : []), os.tmpdir()])];
}

/** The directory the demo's config and profile directories are put in. */
export function demoTempRoot(): string {
  return tempRoots()[0] ?? os.tmpdir();
}

/**
 * Refuse a config or profile directory outside the temp directories (or a temp directory itself), or one that is not
 * under a `job-radar-demo*` directory: the demo empties and refills these, so a real user directory must never be one
 * of them.
 */
export function assertThrowawayDir(dir: string | undefined, label: string, roots: readonly string[] = tempRoots()): string {
  if (!dir) throw new DemoCheckError(`${label} is not set`);
  const resolved = realpathOrSelf(path.resolve(dir));
  const relatives = roots
    .map((tmpRoot) => path.relative(realpathOrSelf(path.resolve(tmpRoot)), resolved))
    .filter((relative) => relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
  if (relatives.length === 0) throw new DemoCheckError(`${label} must be a directory inside a temp directory (${roots.join(" or ")})`);
  // and inside a directory that is the demo's by name: a temp directory of another program is never emptied
  if (!relatives.some((relative) => relative.split(path.sep).some((segment) => segment.startsWith(DEMO_DIR_PREFIX)))) {
    throw new DemoCheckError(`${label} must lie in a directory whose name starts with ${DEMO_DIR_PREFIX}`);
  }
  // return the path as given (resolved, links kept): it is what the pages show
  return path.resolve(dir);
}

/** UTC offset of `zone` at `at`, in minutes. */
function offsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * The demo's "now": `DEMO_HOUR`:00 local time of today in `zone`; before that hour, the same time yesterday (the seed
 * spreads today's jobs between midnight and "now", which must not lie in the future).
 */
export function demoNow(real: Date = new Date(), zone: string = DEMO_TIMEZONE): Date {
  const local = new Date(real.getTime() + offsetMinutes(real, zone) * 60_000);
  let day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), DEMO_HOUR);
  if (local.getUTCHours() < DEMO_HOUR) day -= 86_400_000;
  // local wall time → instant (the offset at that instant; a DST switch at 10:00 does not happen)
  const guess = new Date(day);
  return new Date(day - offsetMinutes(guess, zone) * 60_000);
}

/** The throw-away instance behind the pictures: where its database and its config and profile directories are. */
export interface DemoInstance {
  /** A server where the role may CREATE DATABASE; only the demo database on it is touched. */
  adminUrl: string;
  dbName: string;
  databaseUrl: string;
  configDir: string;
  profileDir: string;
}

/**
 * The instance from the environment, checked: `DEMO_ADMIN_DATABASE_URL` (required), `DEMO_DB_NAME` (default
 * `jobradar_demo`), `DEMO_CONFIG_DIR` / `DEMO_PROFILE_DIR` (default `<temp>/job-radar-demo/{config,profile}`).
 * Throws a `DemoCheckError` for anything that is not a demo database or not a temp directory.
 */
export function demoInstance(env: Readonly<Record<string, string | undefined>> = process.env): DemoInstance {
  const adminUrl = env.DEMO_ADMIN_DATABASE_URL ?? "";
  if (adminUrl === "") throw new DemoCheckError("set DEMO_ADMIN_DATABASE_URL to a Postgres server where the role may CREATE DATABASE (e.g. the compose db)");
  const dbName = assertDemoDbName(env.DEMO_DB_NAME || DEMO_DB_PREFIX);
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new DemoCheckError("DEMO_ADMIN_DATABASE_URL is not a valid URL");
  }
  url.pathname = `/${dbName}`;
  const base = path.join(demoTempRoot(), DEMO_DIR_PREFIX);
  return {
    adminUrl,
    dbName,
    databaseUrl: url.toString(),
    configDir: assertThrowawayDir(env.DEMO_CONFIG_DIR || path.join(base, "config"), "DEMO_CONFIG_DIR"),
    profileDir: assertThrowawayDir(env.DEMO_PROFILE_DIR || path.join(base, "profile"), "DEMO_PROFILE_DIR"),
  };
}
