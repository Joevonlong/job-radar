/** `pnpm run doctor`: result and probe types. Pure types: no I/O. */
import type { Locale } from "@/i18n/locale";
import type { AiConfig, ChannelsConfig, ConfigLayersState, DoctorConfig, LanguageConfig, NotifyConfig, ScheduleConfig } from "@/lib/config";
import type { translatorFor } from "@/lib/i18n/node";
import type { AppliedMigrations } from "@/lib/db/migration-status";
import type { MarketSummaryResult } from "@/lib/market/summary";
import type { ProfileReadiness } from "@/lib/scoring/profile";
import type { RegistryPageData } from "@/lib/sources/registry/load";
import type { SetupStatus } from "@/lib/setup/state";
import type { SourcesView } from "@/lib/sources/view";

import type { BackupFile } from "../backup";
import type { DockerDataLocation } from "../docker-data";

export type CheckStatus = "ok" | "warn" | "fail";

/** Report sections, in display order. */
export const CHECK_GROUPS = ["stack", "processes", "ai", "notify", "network", "data", "channels", "schedule", "host"] as const;
export type CheckGroup = (typeof CHECK_GROUPS)[number];

export interface CheckResult {
  /** Stable machine id, e.g. `compose.runner`. */
  id: string;
  group: CheckGroup;
  /** Short label of what was checked, in the command-line language (`doctor.checks.<id>.title`). */
  title: string;
  status: CheckStatus;
  /** What was found, in the command-line language. Never contains a secret. */
  detail: string;
  /** How to fix it; only on `warn` and `fail`. */
  hint?: string;
}

/** What a check returns: a result whose title may be left out (then `doctor.checks.<id>.title` is used). */
export type CheckOutcome = Omit<CheckResult, "title"> & { title?: string };

/** The `doctor` messages in the command-line language (`language.yaml: cli.locale`, `--lang`). */
export type DoctorTranslator = ReturnType<typeof translatorFor<"doctor">>;

/** An external command's outcome. `missing` = not on PATH, `timeout` = killed after the time-out. */
export type CommandOutcome =
  | { kind: "ran"; exitCode: number | null; stdout: string; stderr: string }
  | { kind: "missing" }
  | { kind: "timeout" };

export interface HttpOutcome {
  /** A 2xx answer. */
  ok: boolean;
  /** null when no answer arrived. */
  status: number | null;
  /** Response body (truncated), when there was an answer. */
  body: string | null;
  /** Why no answer arrived (`timeout`, `ECONNREFUSED` ...); null when there was one. */
  error: string | null;
}

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface MigrationStatus {
  /** Entries of `drizzle/meta/_journal.json` (what this checkout ships); null when the journal cannot be read. */
  expected: { count: number; latestAt: number | null } | null;
  applied: AppliedMigrations;
}

/**
 * Everything the checks need from the outside world. The real implementation is `createRealProbes`
 * (probes.ts); tests pass fakes, so no check ever needs Docker, a database or a network.
 */
export interface DoctorProbes {
  /** Run `command args` (time-out from `doctor.command_timeout_seconds`); never throws. */
  run(command: string, args: readonly string[]): Promise<CommandOutcome>;
  /** GET `url` (time-out from `doctor.probe_timeout_seconds`); never throws. */
  http(url: string): Promise<HttpOutcome>;
  /** True when the database answers `select 1`. */
  dbPing(): Promise<boolean>;
  /** Throws when the database cannot be read. */
  migrations(): Promise<MigrationStatus>;
  /** The same state `/sources` shows (channels, usage, heartbeats, ai-worker, latest cycle). Throws when the database cannot be read. */
  sources(): Promise<SourcesView>;
  /** The source registry: the file state, the mirror and every source's verdict; reads only (no mirror sync). Throws when the database cannot be read. */
  registry(): Promise<RegistryPageData>;
  /** Jobs that passed the filter and still wait for an AI score. Throws when the database cannot be read. */
  unscoredJobs(): Promise<number>;
  /** Whether me.yaml has what scoring needs; null when the file cannot be parsed. Never throws. */
  profile(): Promise<ProfileReadiness | null>;
  /** Scheduled backups in a directory, newest name first; null when the directory does not exist. */
  backups(directory: string): Promise<BackupFile[] | null>;
  /** Free and total space of the volume holding `path`; null when it cannot be read. */
  disk(path: string): Promise<DiskSpace | null>;
  /** Docker Desktop's data folder (its settings' `DataFolder`, else the default location). Never throws. */
  dockerData(): Promise<DockerDataLocation>;
  /** Whether two paths (or their nearest existing parents) are on the same volume; null when one cannot be read. */
  sameVolume(a: string, b: string): Promise<boolean | null>;
  /** Names in a directory; null when it does not exist. */
  listDir(directory: string): Promise<string[] | null>;
  /** The defaults and user config directories (overrides, pending migrations). Never throws. */
  configLayers(): Promise<ConfigLayersState>;
  /** traps.yaml and the trap counts (`stats` null when the tables are not migrated). Throws when the database cannot be read. */
  traps(now: Date): Promise<TrapsProbe>;
  /** The market of preferences.yaml and the packs (or why it cannot be resolved). Never throws. */
  market(): Promise<MarketSummaryResult>;
  /** The first-run setup state (setup.yaml). Never throws. */
  setup(): Promise<SetupStatus>;
  /**
   * Files and directories under `roots` (missing roots are skipped) not owned by `uid`: a sample of at most `sample`
   * paths and the total found within the first `maxEntries` entries walked. Never throws (unreadable entries count as
   * not owned).
   */
  foreignOwned(roots: readonly string[], uid: number, options: { sample: number; maxEntries: number }): Promise<OwnershipScan>;
}

/** What `data.ownership` reads. */
export interface OwnershipScan {
  /** Entries looked at. */
  scanned: number;
  /** Entries not owned by the uid. */
  foreign: number;
  /** Some of them (paths). */
  sample: string[];
  /** The walk stopped at `maxEntries`. */
  truncated: boolean;
}

/** What `data.traps` reads: the switch and thresholds of traps.yaml (or why it cannot be read) and the counts. */
export type TrapsProbe =
  | { state: "ok"; enabled: boolean; backlogWarn: number; recentDays: number; stats: { jobsWithTraps: number; recentJobsWithTraps: number; backlog: number } | null }
  | { state: "config_error"; problem: string };

export interface DoctorContext {
  now: Date;
  /** The language of the report and its texts. */
  locale: Locale;
  t: DoctorTranslator;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /** Numeric user id (launchd's `gui/<uid>` domain); null where there is none. */
  uid: number | null;
  config: {
    schedule: ScheduleConfig;
    notify: NotifyConfig;
    ai: AiConfig;
    channels: ChannelsConfig;
    /** language.yaml; null when it cannot be read (`i18n.config` reports `languageProblem`). */
    language: LanguageConfig | null;
    languageProblem: string | null;
  };
  /** `config.schedule.doctor` with the environment override applied. */
  settings: DoctorConfig;
  /** Absolute directory of the host-side backups (`RUNNER_BACKUP_DIR`). */
  backupDir: string;
  /** Absolute app root (the project directory). */
  appRoot: string;
  /** Seconds of runner silence the container healthcheck tolerates (`RUNNER_HEALTH_MAX_AGE_SECONDS`). */
  runnerMaxAgeSeconds: number;
  probes: DoctorProbes;
}

/** A check that cannot run because something it needs is missing (e.g. the database); reported as a warning, not a crash. */
export class SkipCheck extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipCheck";
  }
}

export interface DoctorReport {
  generatedAt: string;
  /** The language of the titles and texts (ids and statuses are codes in every language). */
  locale: Locale;
  /** Worst status of all checks. */
  worst: CheckStatus;
  /** 0 = all good, 1 = warnings, 2 = failures. */
  exitCode: 0 | 1 | 2;
  summary: Record<CheckStatus, number>;
  checks: CheckResult[];
}

/** A check: one or more results. Throwing `SkipCheck` is a warning; any other throw is a failure of the check itself. */
export interface DoctorCheck {
  id: string;
  group: CheckGroup;
  run(ctx: DoctorContext): Promise<CheckOutcome | CheckOutcome[]>;
}
