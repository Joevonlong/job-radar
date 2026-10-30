import { z } from "zod";

import { DEFAULT_LOG_LEVEL, LOG_LEVELS } from "@/lib/logging/levels";
import { AI_WORKER_DEFAULT_LAUNCHD_LABEL } from "@/lib/ops/ai-worker-label";

import { cronString, nonEmptyString, nonNegativeInt, positiveInt, timeZone } from "./common";

const cycle = z.strictObject({
  cron: cronString,
  enabled: z.boolean().default(true),
});

/** Database backup job: a pg_dump the runner takes on a cron of its own, in the schedule's time zone. */
const backup = z.strictObject({
  enabled: z.boolean(),
  cron: cronString,
  /** Keep the newest backup of each of the last N days that have one. */
  keep_daily: positiveInt,
  /** Also keep the newest backup of each of the last N ISO weeks that have one (0 = no weekly backups). */
  keep_weekly: nonNegativeInt,
  /** pg_dump is killed and the run counts as failed after this many minutes. */
  timeout_minutes: positiveInt,
  /** `pnpm run doctor` reports a failure when the newest backup is older than this many hours (the cron is daily: leave slack). */
  max_age_hours: positiveInt.default(30),
  /** Put the user's config and profile (`data/config`, `data/profile`) next to every daily dump as a `.config.tgz`. */
  config_archive: z.boolean().default(true),
  /** Take a `premigrate` backup before the runner or `pnpm migrate:run` applies pending database migrations. */
  pre_migrate: z.boolean().default(true),
  /** Keep this many of each kind of safety backup (`pre-deploy`, `pre-restore`, `premigrate`); manual backups with your own label are never pruned. */
  keep_system: positiveInt.default(5),
  /** scripts/ops/restore.sh keeps this many `<db>_before_restore_<time>` databases after a restore into the main database (older ones are dropped). */
  keep_old_databases: positiveInt.default(1),
});

/**
 * The daily "recommended for you" read of the LinkedIn session channel. It is not a job of its own: the first
 * processing cycle after the day's cron slot that has not read it yet does it (a manual cycle always does).
 */
const linkedinRecommended = z.strictObject({
  enabled: z.boolean(),
  cron: cronString,
});

export type LinkedinRecommendedSchedule = z.infer<typeof linkedinRecommended>;

const LINKEDIN_RECOMMENDED_DEFAULTS: LinkedinRecommendedSchedule = { enabled: true, cron: "0 7 * * *" };

/** What `pnpm run doctor` checks and how strictly: names, URLs, time-outs and thresholds. Read on the host only. */
const doctor = z.strictObject({
  /** The compose project that holds the stack (`name:` in compose.yaml). */
  compose_project: nonEmptyString,
  /** Services of that project that must be running and healthy. */
  compose_services: z.array(nonEmptyString).min(1),
  /** The dashboard as the host sees it (compose publishes web on loopback only, C5). `JOB_RADAR_DOCTOR_WEB_URL` overrides it. */
  web_url: z.url({ protocol: /^https?$/ }),
  /** One HTTP request or TCP connect may take this long. */
  probe_timeout_seconds: positiveInt,
  /** `docker`, `launchctl`, `claude`, `codex`, `tailscale`, `pmset` are killed after this long. */
  command_timeout_seconds: positiveInt,
  /** Less free disk than this (GB) is a failure ... */
  min_free_disk_gb: positiveInt,
  /** ... and less than this a warning. */
  warn_free_disk_gb: positiveInt,
  /** Warn when this many AI requests wait for the ai-worker. */
  ai_backlog_warn: positiveInt,
  /** Warn when this many scored-eligible jobs still wait for their AI score. */
  ai_unscored_warn: positiveInt,
  /** Warn when the oldest waiting AI request is older than this many minutes. */
  ai_oldest_pending_warn_minutes: positiveInt,
  /** A scheduled cycle that has not started this many minutes after its slot counts as missed. */
  cycle_grace_minutes: positiveInt,
  /** launchd label of the host ai-worker (scripts/ops/install-ai-worker.sh). */
  ai_worker_launchd_label: nonEmptyString,
  /** Directory (relative to the app root) where browser login states are kept (`.auth/`, gitignored). */
  linkedin_auth_dir: nonEmptyString,
  /** Free space (GB) of the Mac's internal system data volume (`disk.internal`): less than this is a failure ... */
  internal_min_free_disk_gb: positiveInt.default(10),
  /** ... and less than this a warning. */
  internal_warn_free_disk_gb: positiveInt.default(30),
  /** The guide (default: docs/host-setup.md) that `disk.docker_location` points at when Docker's data is not on the project volume. */
  storage_guide: nonEmptyString.default("docs/host-setup.md"),
  /**
   * `config.shipped`: a container's report of its shipped config counts when it was written at most this many seconds before
   * Docker's start time of the container (the database and the Docker daemon may disagree a little on the time).
   */
  shipped_report_skew_seconds: nonNegativeInt.default(2),
})
  .refine((d) => d.warn_free_disk_gb >= d.min_free_disk_gb, { message: "warn_free_disk_gb must be >= min_free_disk_gb", path: ["warn_free_disk_gb"] })
  .refine((d) => d.internal_warn_free_disk_gb >= d.internal_min_free_disk_gb, { message: "internal_warn_free_disk_gb must be >= internal_min_free_disk_gb", path: ["internal_warn_free_disk_gb"] });

export type DoctorConfig = z.infer<typeof doctor>;

const DOCTOR_DEFAULTS: DoctorConfig = {
  compose_project: "job-radar",
  compose_services: ["db", "web", "runner", "jobspy"],
  web_url: "http://127.0.0.1:3000",
  probe_timeout_seconds: 5,
  command_timeout_seconds: 15,
  min_free_disk_gb: 5,
  warn_free_disk_gb: 20,
  ai_backlog_warn: 40,
  ai_unscored_warn: 200,
  ai_oldest_pending_warn_minutes: 30,
  cycle_grace_minutes: 90,
  ai_worker_launchd_label: AI_WORKER_DEFAULT_LAUNCHD_LABEL,
  linkedin_auth_dir: ".auth",
  internal_min_free_disk_gb: 10,
  internal_warn_free_disk_gb: 30,
  storage_guide: "docs/host-setup.md",
  shipped_report_skew_seconds: 2,
};

/** Docker housekeeping `scripts/ops/deploy.sh` does once the stack is up. Never touches volumes or images in use. */
const deploy = z.strictObject({
  /** Trim the Docker build cache after a deploy ... */
  prune_build_cache: z.boolean(),
  /** ... down to this many GB, least recently used first (`docker builder prune --max-used-space`); 0 = remove all unused build cache. */
  build_cache_keep_gb: nonNegativeInt,
  /** Remove dangling images: untagged leftovers of earlier builds (`docker image prune`, without `-a`). */
  prune_dangling_images: z.boolean(),
  /**
   * Before the containers are recreated, wait at most this many seconds for a running cycle to finish (it cannot be
   * resumed; one cut off is run again by the runner's catch-up). 0 = do not wait.
   */
  drain_timeout_seconds: nonNegativeInt.default(900),
  /** ... looking every this many seconds. */
  drain_poll_seconds: positiveInt.default(10),
  /** Release directories of the host ai-worker (data/releases/ai-worker/) kept in total, the installed and the previous one included. */
  ai_worker_releases_keep: z.number().int().min(2).default(3),
  /**
   * How long the service manager waits after SIGTERM before it kills the ai-worker (launchd ExitTimeOut, systemd
   * TimeoutStopSec). Keep it above ai.yaml host_worker.shutdown_grace_seconds.
   */
  ai_worker_stop_timeout_seconds: z.number().int().min(10).default(60),
  /**
   * Upper bound of each wait while the install script swaps the worker (old process gone, new one with database
   * evidence, and the same on rollback); at least ai_worker_stop_timeout_seconds + 10.
   * Also the longest wait of deploy.sh step 11 (`--settle` overrides it).
   */
  ai_worker_swap_timeout_seconds: positiveInt.default(120),
  /** Same-host write locks check PID and process generation; foreign hosts/namespaces use the stale threshold. */
  config_write_lock_stale_seconds: positiveInt.default(300),
  config_write_lock_wait_seconds: z.number().positive().default(10),
  config_write_lock_retry_ms: positiveInt.default(50),
}).superRefine((value, ctx) => {
  if (value.ai_worker_swap_timeout_seconds < value.ai_worker_stop_timeout_seconds + 10) {
    ctx.addIssue({
      code: "custom",
      path: ["ai_worker_swap_timeout_seconds"],
      message: `must be at least ai_worker_stop_timeout_seconds + 10 (${value.ai_worker_stop_timeout_seconds + 10})`,
    });
  }
});

export type DeployConfig = z.infer<typeof deploy>;

const DEPLOY_DEFAULTS: DeployConfig = {
  prune_build_cache: true,
  build_cache_keep_gb: 5,
  prune_dangling_images: true,
  drain_timeout_seconds: 900,
  drain_poll_seconds: 10,
  ai_worker_releases_keep: 3,
  ai_worker_stop_timeout_seconds: 60,
  ai_worker_swap_timeout_seconds: 120,
  config_write_lock_stale_seconds: 300,
  config_write_lock_wait_seconds: 10,
  config_write_lock_retry_ms: 50,
};

/** The manual buttons of /sources and /settings (run a channel now, test a channel / AI provider / Telegram). */
const manualTriggers = z.strictObject({
  /** A finished request of the same kind and target blocks a new one for this long (a request still open is reused instead). */
  min_interval_seconds: nonNegativeInt,
});

export type ManualTriggersConfig = z.infer<typeof manualTriggers>;

const MANUAL_TRIGGERS_DEFAULTS: ManualTriggersConfig = { min_interval_seconds: 30 };

/**
 * A scheduled cycle that finds the cycle lock held by a cycle limited to some channels (a manual "collect now" of one
 * channel, a `pnpm cycle:run --channel`) waits for it instead of being skipped, then runs. A cycle that covers every
 * channel still makes it skip (`skip_if_running`).
 */
const partialCycleWait = z.strictObject({
  /** The longest wait; a scheduled cycle that still finds the lock held after this long is recorded as skipped. 0 = do not wait (skip). */
  max_minutes: nonNegativeInt.default(60),
  /** How often the waiting cycle tries the lock again. */
  poll_seconds: positiveInt.default(15),
});

export type PartialCycleWaitConfig = z.infer<typeof partialCycleWait>;

const PARTIAL_CYCLE_WAIT_DEFAULTS: PartialCycleWaitConfig = { max_minutes: 60, poll_seconds: 15 };

/** Application statuses the weekly interests suggestion reads: the enum of `application_status`. */
const suggestStatus = z.enum(["new", "interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"]);

const suggestStatusList = z
  .array(suggestStatus)
  .min(1)
  .refine((items) => new Set(items).size === items.length, "must not contain duplicates");

/** Weekly AI suggestions for the interests list: when it runs and what it looks at. */
const suggest = z
  .strictObject({
    enabled: z.boolean(),
    cron: cronString,
    /** Only jobs whose application status changed within this many weeks are looked at. */
    lookback_weeks: positiveInt,
    /** Statuses that count as "the user liked this job" (the evidence for new words, companies, filters). */
    positive_statuses: suggestStatusList,
    /** Statuses that count as "the user ignored this job" (the contrast the AI compares against). */
    ignored_statuses: suggestStatusList,
    /** Fewer positive jobs than this: nothing to learn from, no AI call. */
    min_positive_jobs: positiveInt,
    /** At most this many positive / ignored jobs go to the AI (the strongest signals and the newest first). */
    max_positive_jobs: positiveInt,
    max_ignored_jobs: nonNegativeInt,
    /** Longest JD (characters) sent per job. */
    jd_max_chars: positiveInt.min(500),
    /** At most this many new suggestions are stored per run. */
    max_suggestions: positiveInt,
    /** Suggestions the AI is less sure about than this (0 to 1) are dropped. */
    min_confidence: z.number().min(0).max(1),
    /** How many of the cited jobs must back a suggestion (a word that shows up in one job only is no pattern). */
    min_evidence: z.strictObject({
      signal_word: positiveInt,
      watched_company: positiveInt,
      filter: positiveInt,
    }),
    /** Longest term (word, company, city) a suggestion may carry. */
    max_term_chars: positiveInt,
    /** Send one Telegram message when a run found new suggestions. */
    notify: z.boolean(),
  })
  .refine((c) => !c.positive_statuses.some((status) => c.ignored_statuses.includes(status)), {
    message: "a status cannot be both positive and ignored",
    path: ["ignored_statuses"],
  });

export type SuggestConfig = z.infer<typeof suggest>;

const SUGGEST_DEFAULTS: SuggestConfig = {
  enabled: true,
  cron: "0 8 * * 1",
  lookback_weeks: 4,
  positive_statuses: ["interested", "preparing", "applied", "interviewing", "offer"],
  ignored_statuses: ["archived"],
  min_positive_jobs: 3,
  max_positive_jobs: 20,
  max_ignored_jobs: 10,
  jd_max_chars: 3000,
  max_suggestions: 10,
  min_confidence: 0.5,
  min_evidence: { signal_word: 2, watched_company: 1, filter: 2 },
  max_term_chars: 60,
  notify: true,
};

/**
 * How much the long-running processes (web, runner, ai-worker) and `pnpm cycle:run` log. `JOB_RADAR_LOG_LEVEL` wins over
 * it. A schema default only: the shipped schedule.yaml does not carry the block.
 */
const logging = z.strictObject({
  /** The lowest level written: `debug` adds the diagnostic records (provider checks, retries, skipped chats). */
  level: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
});

export type LoggingConfig = z.infer<typeof logging>;

const LOGGING_DEFAULTS: LoggingConfig = { level: DEFAULT_LOG_LEVEL };

/** config/schedule.yaml — processing cycles. */
export const scheduleSchema = z.strictObject({
  timezone: timeZone,
  cycles: z.strictObject({
    weekday_morning: cycle,
    weekday_evening: cycle,
    weekend: cycle,
  }),
  /** On runner start, run the most recently missed cycle once. */
  catch_up: z.boolean(),
  /** Skip a cycle when the previous one is still running (and log it). */
  skip_if_running: z.boolean(),
  /** With `skip_if_running`: how a scheduled cycle waits for a running cycle limited to some channels; a file without the block gets the schema defaults. */
  partial_cycle_wait: partialCycleWait.default(PARTIAL_CYCLE_WAIT_DEFAULTS),
  backup,
  /** How often the runner looks for requests the web app left in `control_requests` (manual cycle, re-score). */
  control_poll_seconds: positiveInt.default(5),
  /** When the LinkedIn "recommended for you" side channel reads once a day; a file without the block gets the defaults of the shipped YAML. */
  linkedin_recommended: linkedinRecommended.default(LINKEDIN_RECOMMENDED_DEFAULTS),
  /** Weekly interests suggestions; a file without the block gets the defaults of the shipped YAML. */
  suggest: suggest.default(SUGGEST_DEFAULTS),
  /** `pnpm run doctor`; a file without the block gets the defaults of the shipped YAML. */
  doctor: doctor.default(DOCTOR_DEFAULTS),
  /** Docker housekeeping of `scripts/ops/deploy.sh`; a file without the block gets the defaults of the shipped YAML. */
  deploy: deploy.default(DEPLOY_DEFAULTS),
  /** Rate limit of the manual buttons; a file without the block gets the defaults of the shipped YAML. */
  manual_triggers: manualTriggers.default(MANUAL_TRIGGERS_DEFAULTS),
  /** Log level of the processes; a file without the block logs at `info`. */
  logging: logging.default(LOGGING_DEFAULTS),
});

export type BackupConfig = z.infer<typeof backup>;
export type ScheduleConfig = z.infer<typeof scheduleSchema>;
