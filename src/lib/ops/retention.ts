/**
 * Backup file naming and the retention policy. Pure: no clock, no filesystem.
 *
 * A backup is `jobradar-YYYYMMDD-HHMMSS.dump`, the wall-clock time being in the schedule's time zone.
 * Classification therefore reads only the name; a file whose name does not match (a manual
 * `jobradar-manual-…` backup, a `.partial` file, anything else) is never counted and never deleted.
 */

export const BACKUP_FILE_PREFIX = "jobradar";
export const BACKUP_FILE_EXTENSION = ".dump";
/** The user's config and profile next to a dump: `<dump name without .dump>.config.tgz`. */
export const CONFIG_ARCHIVE_EXTENSION = ".config.tgz";

const BACKUP_NAME = /^jobradar-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dump$/;
const CONFIG_ARCHIVE_NAME = /^(jobradar-\d{8}-\d{6})\.config\.tgz$/;
const SYSTEM_BACKUP_NAME = /^jobradar-manual-(\d{8})-(\d{6})-([A-Za-z0-9_-]+)\.dump$/;
/** Label prefixes of the backups the scripts and the runner make by themselves (and may therefore prune). */
export const SYSTEM_BACKUP_LABELS = ["pre-deploy", "pre-restore", "premigrate"] as const;
export type SystemBackupLabel = (typeof SYSTEM_BACKUP_LABELS)[number];
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ParsedBackupName {
  name: string;
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  /** Local ISO week, "YYYY-Www". */
  week: string;
  /** "YYYYMMDDHHMMSS": sorts chronologically as a string. */
  stamp: string;
}

export interface RetentionPolicy {
  /** Newest backup of each of the last N days that have one. */
  keepDaily: number;
  /** Newest backup of each of the last N ISO weeks that have one. */
  keepWeekly: number;
}

export interface RetentionPlan {
  /** Backup names to keep, newest first. */
  keep: string[];
  /** Backup names to delete, newest first. */
  remove: string[];
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** "2026-W41": the ISO 8601 week (Monday first; week 1 holds the year's first Thursday) of a calendar day. */
export function isoWeekKey(year: number, month: number, day: number): string {
  const date = Date.UTC(year, month - 1, day);
  const weekdayIndex = (new Date(date).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = date + (3 - weekdayIndex) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const firstThursday = jan4 + (3 - ((new Date(jan4).getUTCDay() + 6) % 7)) * DAY_MS;
  const week = 1 + Math.round((thursday - firstThursday) / (7 * DAY_MS));
  return `${isoYear}-W${pad(week, 2)}`;
}

/** Null when `name` is not a scheduled backup name, or names a date or time that does not exist. */
export function parseBackupName(name: string): ParsedBackupName | null {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  if (!real || hour > 23 || minute > 59 || second > 59) return null;
  return {
    name,
    day: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
    week: isoWeekKey(year, month, day),
    stamp: `${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}${pad(hour, 2)}${pad(minute, 2)}${pad(second, 2)}`,
  };
}

/** `YYYYMMDD-HHMMSS` for the wall clock of `at` in `timeZone`. */
function formatStamp(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${part("year")}${part("month")}${part("day")}`;
  const time = `${part("hour")}${part("minute")}${part("second")}`;
  return `${date}-${time}`;
}

/** `jobradar-YYYYMMDD-HHMMSS.dump` for the wall clock of `at` in `timeZone`. */
export function formatBackupName(at: Date, timeZone: string): string {
  return `${BACKUP_FILE_PREFIX}-${formatStamp(at, timeZone)}${BACKUP_FILE_EXTENSION}`;
}

/** `jobradar-manual-YYYYMMDD-HHMMSS-<label>.dump`, the name scripts/ops/backup.sh gives (so restore.sh and --latest know it). */
export function formatManualBackupName(at: Date, timeZone: string, label: string): string {
  return `${BACKUP_FILE_PREFIX}-manual-${formatStamp(at, timeZone)}-${label}${BACKUP_FILE_EXTENSION}`;
}

/** The config archive that belongs to a dump name (`x.dump` -> `x.config.tgz`). */
export function configArchiveName(dumpName: string): string {
  return `${dumpName.slice(0, -BACKUP_FILE_EXTENSION.length)}${CONFIG_ARCHIVE_EXTENSION}`;
}

/** Scheduled config archives (`jobradar-YYYYMMDD-HHMMSS.config.tgz`) that have no dump with the same stem. */
export function orphanConfigArchives(names: readonly string[]): string[] {
  const dumps = new Set(names.filter((name) => name.endsWith(BACKUP_FILE_EXTENSION)));
  return names.filter((name) => {
    const match = CONFIG_ARCHIVE_NAME.exec(name);
    return match !== null && !dumps.has(`${match[1]}${BACKUP_FILE_EXTENSION}`);
  });
}

export function systemBackupLabel(name: string): SystemBackupLabel | null {
  const label = SYSTEM_BACKUP_NAME.exec(name)?.[3];
  if (label === undefined) return null;
  return SYSTEM_BACKUP_LABELS.find((known) => label === known || label.startsWith(`${known}-`)) ?? null;
}

/**
 * Which of the script- and runner-made safety backups (`jobradar-manual-<stamp>-<label>.dump` with a `pre-deploy`,
 * `pre-restore` or `premigrate` label) to keep: the newest `keep` of each label, by the stamp in the name. A manual backup
 * without a label, or with a label of the user's own, is never listed and never removed.
 */
export function planSystemRetention(names: readonly string[], keep: number): RetentionPlan {
  const byLabel = new Map<SystemBackupLabel, { name: string; stamp: string }[]>();
  for (const name of names) {
    const match = SYSTEM_BACKUP_NAME.exec(name);
    const label = systemBackupLabel(name);
    if (!match || label === null) continue;
    const list = byLabel.get(label) ?? [];
    list.push({ name, stamp: `${match[1]}${match[2]}` });
    byLabel.set(label, list);
  }
  const kept: string[] = [];
  const removed: string[] = [];
  for (const list of byLabel.values()) {
    list.sort((a, b) => (a.stamp === b.stamp ? b.name.localeCompare(a.name) : b.stamp.localeCompare(a.stamp)));
    list.forEach((entry, index) => (index < Math.max(0, keep) ? kept : removed).push(entry.name));
  }
  return { keep: kept.sort().reverse(), remove: removed.sort().reverse() };
}

/**
 * Which backups to keep. The result is the union of
 *  - daily: the newest backup of each of the `keepDaily` most recent days that have one, and
 *  - weekly: the newest backup of each of the `keepWeekly` most recent ISO weeks that have one.
 * "Most recent" counts days / weeks that have a backup, not calendar days, so a runner that was off for
 * a month does not lose its history. Everything else that is named like a backup is removed.
 */
export function planRetention(names: readonly string[], policy: RetentionPolicy): RetentionPlan {
  const parsed = names
    .map(parseBackupName)
    .filter((entry): entry is ParsedBackupName => entry !== null)
    .sort((a, b) => (a.stamp === b.stamp ? b.name.localeCompare(a.name) : b.stamp.localeCompare(a.stamp)));

  const keep = new Set<string>();
  const take = (key: (entry: ParsedBackupName) => string, limit: number): void => {
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (seen.size >= limit) return;
      const k = key(entry);
      if (seen.has(k)) continue;
      seen.add(k);
      keep.add(entry.name);
    }
  };
  take((entry) => entry.day, Math.max(0, policy.keepDaily));
  take((entry) => entry.week, Math.max(0, policy.keepWeekly));

  return {
    keep: parsed.filter((entry) => keep.has(entry.name)).map((entry) => entry.name),
    remove: parsed.filter((entry) => !keep.has(entry.name)).map((entry) => entry.name),
  };
}
