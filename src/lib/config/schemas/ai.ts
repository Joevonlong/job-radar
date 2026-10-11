import { z } from "zod";

import { AI_API_PROVIDERS, AI_PROVIDER_IDS, AI_PROVIDER_KINDS, AI_TASK_NAMES, AI_TASK_PROVIDERS, CODEX_REASONING_EFFORTS } from "../ai-options";

import { nonNegativeInt, nonNegativeNumber, nonEmptyString, positiveInt, score0to100 } from "./common";

export { CODEX_REASONING_EFFORTS } from "../ai-options";

/** Settings shared by the two subscription CLIs (spawned as child processes, cost 0). */
const providerPolicy = {
  /** false: the router never tries this provider. */
  enabled: z.boolean(),
  /** Most requests (model calls, failed ones included) per day; 0 = unlimited. The day follows schedule.yaml `timezone`. */
  daily_request_cap: nonNegativeInt,
};

const cliProvider = {
  ...providerPolicy,
  /** Executable name (looked up on PATH) or an absolute path. */
  command: nonEmptyString,
  timeout_seconds: positiveInt,
};


/** A Codex config key or feature name: lower-case words only, so it can never smuggle extra argv or TOML syntax into `-c key=value`. */
/** `X.Y.Z` (a pre-release suffix is allowed and ignored when versions are compared). */
const codexMinVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "must be a version like 0.122.0");

const codexKey = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, "must match ^[a-z0-9_.]+$ (lower-case words separated by dots)");
/** A TOML value for `-c key=value`: one line, no control characters. */
const tomlValue = z.string().min(1).regex(/^[^\u0000-\u001f\u007f]*$/, "must be a single-line TOML value");

const providerKind = z.enum(AI_PROVIDER_KINDS);
const apiProvider = z.enum(AI_API_PROVIDERS);
/** A task may name individual providers or the "api" layer as a whole. */
const taskProvider = z.enum(AI_TASK_PROVIDERS);

const unique = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .min(1)
    .refine((xs) => new Set(xs).size === xs.length, "must not contain duplicates");

const task = z.strictObject({
  /** Optional per-task override of the global provider order. */
  order: unique(taskProvider).optional(),
  /**
   * Provider id -> model id for this task. Only for providers listed directly in the task's own `order`
   * (the `api` layer expands to providers that use their default models). Checked against models.yaml elsewhere.
   */
  models: z.partialRecord(z.enum(AI_PROVIDER_IDS), nonEmptyString).optional(),
});

/** Local-language levels a posting can require (CEFR); `none` / `unknown` never cost points. */
const GERMAN_PENALTY_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;

const fraction = z.number().min(0).max(1);
const weight = z.number().min(0).max(1000);

/**
 * `scoring.priority`: the cheap, AI-free relevance pre-score that decides which waiting jobs the
 * AI scores first. Priority = sum of `weight x component` (components are 0..1) minus the German gap.
 * Only the order matters, the number is never shown as a score.
 */
const priority = z.strictObject({
  weights: z.strictObject({
    /** Title matches a target title (preferences.yaml) or a search keyword (search.yaml). */
    title: weight,
    /** Compensation signals: the stored signal bonus as a share of interests.yaml `bonus_cap`. */
    signals: weight,
    /** Location is one of the wanted cities, nearby, remote in scope, or unknown. */
    location: weight,
    /** Seniority fit, from `seniority_fit`. */
    seniority: weight,
    /** Newer postings first (see `recency_days`). */
    recency: weight,
    /** Subtracted in proportion to the local-language deduction the posting would cost (`language_penalty`; was `german_gap`). */
    language_gap: weight,
  }),
  /** Title match for a term of search.yaml keyword_groups, relative to a target title (1 = same). */
  keyword_group_factor: fraction,
  /** Title match when every word of the term is in the title but not next to each other. */
  all_words_match: fraction,
  /** Title match when at least half of the words of the term are in the title: this share times the fraction of words found. */
  partial_match: fraction,
  /**
   * Words too common in job titles to count on their own: a title that shares only these with a target
   * ("Cooling Flow Design Engineer" vs "AI Engineer") is no partial match. Compared after case and accent folding.
   */
  generic_title_words: z.array(nonEmptyString),
  /**
   * true: the seniority fit follows preferences.yaml `seniority` (`entry` / `mid` / `senior` / `lead`: the closer the posting's
   * level to the wanted one, the higher; `all`: no preference). false: use the `seniority_fit` table as written.
   * Default false so an existing file keeps its behaviour; the shipped ai.yaml sets true (new installs).
   */
  seniority_from_preferences: z.boolean().default(false),
  /** With `seniority_from_preferences`: fit for a posting 0, 1, 2, 3+ levels away from the wanted level (the last value repeats). */
  seniority_distance_fit: z.array(fraction).min(1).default([1, 0.7, 0.4, 0.15]),
  /** Seniority fit by the seniority the pipeline read from the title; every value `jobs.seniority` can have needs an entry. Used when `seniority_from_preferences` is false. */
  seniority_fit: z.strictObject({
    intern: fraction,
    junior: fraction,
    mid: fraction,
    senior: fraction,
    staff: fraction,
    principal: fraction,
    lead: fraction,
    manager: fraction,
    unknown: fraction,
  }),
  /**
   * Location fit: a wanted city, a place near one, a remote posting in scope, anything else, or a posting
   * whose place the hard filter could not place (it kept the job with a "scope unknown" / "location unknown" note).
   */
  /** `country_level`: an on-site / hybrid posting that names only the country ("Germany"). Default 0.5. */
  location_fit: z.strictObject({ exact: fraction, nearby: fraction, remote: fraction, country_level: fraction.default(0.5), other: fraction, unclear: fraction }),
  /** The whole priority of a posting the hard filter could not place (`location_fit.unclear`) is multiplied by this: such jobs are usually outside Germany. */
  unclear_location_factor: fraction,
  /** A posting this many days old (or older) gets no recency points; the rest decays linearly. */
  recency_days: positiveInt,
});

/** Most entries of each `scoring.criteria` list, and characters of one entry. */
export const MAX_CRITERIA = 10;
export const MAX_CRITERION_CHARS = 300;
const criterionList = z.array(z.string().trim().min(1).max(MAX_CRITERION_CHARS)).max(MAX_CRITERIA).default([]);

/** `scoring` block: how the scorer builds the prompt and turns the model's answer into the match score. */
const scoring = z.strictObject({
  /** Longest JD (characters) sent to the model; a longer text keeps its beginning and its end. */
  jd_max_chars: positiveInt.min(500),
  /** Share of `jd_max_chars` taken from the beginning when a JD is cut (the rest comes from the end, where German requirements often sit). */
  jd_head_share: z.number().min(0.1).max(0.9),
  /** Postings scored at the same time. */
  concurrency: positiveInt.max(8),
  /**
   * Points taken off the match score when the posting requires a level of the market's local language (was
   * `german_penalty`) above the user's own in me.yaml. Keyed by the required level; a level without an entry costs nothing. Computed in code,
   * outside the prompt, so the deduction is always the same.
   */
  language_penalty: z.partialRecord(z.enum(GERMAN_PENALTY_LEVELS), nonNegativeInt),
  /**
   * Postings one "score the backlog" request (/settings) scores. The cycle keeps its own `per_cycle_limit`;
   * this is the separate budget for the waiting jobs, so a backlog can be drained without raising the cycle limit.
   */
  backlog_per_run: positiveInt,
  /** The order waiting postings are scored in, for cycles and for the backlog. */
  priority,
  /**
   * The user's own scoring criteria, each one sentence in any language, sent to the model with the prompt (preferences,
   * C5). `dealbreakers` push a posting into the 0-29 band. Changing them re-scores (`score-v1+c<hash>`). Absent = none.
   */
  criteria: z
    .strictObject({
      priorities: criterionList,
      dealbreakers: criterionList,
      nice_to_have: criterionList,
    })
    .default({ priorities: [], dealbreakers: [], nice_to_have: [] }),
});

/** Where the AI work of a cycle runs. */
export const AI_EXECUTION_MODES = ["host", "container"] as const;

/**
 * `host_worker` block: the launchd process on the Mac that runs the AI steps with the
 * subscription logins of the local `claude` / `codex`.
 */
const hostWorker = z.strictObject({
  /** Seconds between two looks at the control-request queue. */
  poll_seconds: positiveInt,
  /** Most requests one look handles before it goes back to waiting (the rest follow on the next look). */
  max_requests_per_poll: positiveInt,
  /** Seconds between two heartbeats of the ai-worker. */
  heartbeat_seconds: positiveInt,
  /** The worker counts as offline (and /sources warns, the runner sends an alert) when its newest heartbeat is older than this. */
  offline_after_seconds: positiveInt,
  /** Minutes between two measurements of the host disk (the volume doctor's `disk.docker` checks); /sources shows the low-disk banner from it. */
  disk_check_minutes: positiveInt,
  /** The worker's own log files (`--log-dir`) are rotated once larger than this many MB ... */
  log_max_mb: positiveInt.default(10),
  /** ... keeping this many older copies (`.1` is the newest); 0 = only empty the file. */
  log_keep: nonNegativeInt.default(3),
  /** After SIGTERM the process gets this many seconds to finish (in-flight request, pool); then it logs an error and exits so launchd / Docker restarts it. A second signal exits at once. */
  shutdown_grace_seconds: positiveInt.default(30),
  /**
   * A control request the shutdown (or a crash) interrupts goes back to the queue and runs again after the restart,
   * at most this many times; then it fails. 0 = fail at once (the old behaviour). Read by the ai-worker and the runner.
   */
  requeue_interrupted_max: nonNegativeInt.default(3),
  /**
   * An ai-worker that finds another one running (the single-instance lock is taken) waits this many seconds before it
   * exits, so a supervisor that restarts it at once (launchd KeepAlive) does not spin; `--once` exits at once. 0 = no wait.
   */
  already_running_wait_seconds: nonNegativeInt.default(60),
  /** One heartbeat write or one disk measurement may take this many seconds; a longer one is abandoned (logged) so the heartbeat loop never hangs behind it. */
  step_timeout_seconds: positiveInt.default(20),
  /**
   * Docker Desktop's data folder (absolute path), measured for the /sources low-disk banner. Absent: the worker reads it from
   * Docker's settings file, which under launchd can block on a macOS privacy prompt (the measurement then times out and the banner
   * never updates). `pnpm run doctor` prints the value to set here.
   */
  docker_data_path: nonEmptyString.refine((value) => value.startsWith("/"), "must be an absolute path").optional(),
});

/** `translation` block: how a JD is cut up and how long one piece may take. */
const translation = z.strictObject({
  /** Longest piece (characters) sent in one request; the JD is cut at paragraph boundaries. Smaller pieces answer faster and a failure costs less. */
  chunk_chars: positiveInt.min(500),
  /** Time one provider gets for one piece, whatever its own `timeout_seconds` says (the CLIs are slow). After a timeout the next provider is tried, and the slow one is skipped for the rest of the job. */
  chunk_timeout_seconds: positiveInt,
  /**
   * Fixed renderings, source term -> Chinese (or the same term to keep it in English). Without it the model picks a
   * new translation of a job title each time ("Forward Deployed Engineer" came out four ways). Matched case-insensitively
   * in the text; only the terms that occur in a piece are sent with it.
   */
  glossary: z.record(nonEmptyString, nonEmptyString),
});

/**
 * The shipped `quota_guard` values, also the defaults of a file written before the block existed (an older user ai.yaml
 * keeps parsing and gets the same caps as a new install). The numbers follow the rule in the block's comment in ai.yaml.
 */
export const QUOTA_GUARD_DEFAULTS = {
  enabled: true,
  fallthrough_to_api: false,
  resume_ratio: 0.8,
  alert_dedupe_hours: 6,
  notify_recovery: true,
  providers: {
    codex_cli: { window_hours: 5, hard_requests: 320, cycle_request_cap: 160 },
    claude_cli: { window_hours: 5, hard_requests: 20, cycle_request_cap: 10 },
  },
} as const;

/** One subscription CLI's caps: calls (failed ones included) counted from `ai_usage`; 0 = that cap is off. */
const quotaGuardProvider = (defaults: { window_hours: number; hard_requests: number; cycle_request_cap: number }) =>
  z.strictObject({
    /** Length of the rolling window the calls are counted in. */
    window_hours: positiveInt.max(168).default(defaults.window_hours),
    /** At this many calls inside the window the provider is paused for every task; 0 = no window cap. */
    hard_requests: nonNegativeInt.default(defaults.hard_requests),
    /** Most calls one processing cycle may make (counted from the cycle's start, main and late phase together); 0 = no cycle cap. */
    cycle_request_cap: nonNegativeInt.default(defaults.cycle_request_cap),
  });

/**
 * `quota_guard`: Job Radar's own cap on its use of the subscription CLIs (claude-cli, codex-cli). It counts only the calls
 * Job Radar made (`ai_usage`); it knows nothing of the account's real remaining quota, so it can only trigger late, never early.
 */
const quotaGuard = z.strictObject({
  /** false = no caps at all (behaviour as before the guard existed). */
  enabled: z.boolean().default(QUOTA_GUARD_DEFAULTS.enabled),
  /** false: a task whose subscription CLI was skipped by a cap never falls through to the paid API providers. */
  fallthrough_to_api: z.boolean().default(QUOTA_GUARD_DEFAULTS.fallthrough_to_api),
  /** After a window cap the provider resumes once its window count is below this share of `hard_requests` (hysteresis). */
  resume_ratio: z.number().gt(0).max(1).default(QUOTA_GUARD_DEFAULTS.resume_ratio),
  /** Alerts fire on state changes; the same alert is still never repeated within this many hours (anti-flap). */
  alert_dedupe_hours: positiveInt.default(QUOTA_GUARD_DEFAULTS.alert_dedupe_hours),
  /** Send one Telegram message when a capped or cooling provider is usable again. */
  notify_recovery: z.boolean().default(QUOTA_GUARD_DEFAULTS.notify_recovery),
  providers: z
    .strictObject({
      codex_cli: quotaGuardProvider(QUOTA_GUARD_DEFAULTS.providers.codex_cli).prefault({}),
      claude_cli: quotaGuardProvider(QUOTA_GUARD_DEFAULTS.providers.claude_cli).prefault({}),
    })
    .prefault({}),
});

/** config/ai.yaml — provider order, models, limits. */
export const aiSchema = z.strictObject({
  /**
   * `host`: the container runner only queues a `run_ai` request and the ai-worker on the host does the AI and
   * notify steps (no AI credential in the container). `container`: the runner does them itself.
   */
  execution: z.enum(AI_EXECUTION_MODES),
  host_worker: hostWorker,
  order: unique(providerKind),
  api_order: unique(apiProvider),
  providers: z.strictObject({
    claude_cli: z.strictObject({
      ...cliProvider,
      /** Passed to `claude --model` (alias or full name). */
      model: nonEmptyString,
      strong_model: nonEmptyString,
    }),
    codex_cli: z.strictObject({
      ...cliProvider,
      /**
       * Passed to `codex exec -m`. Omitted: the CLI's built-in default model (the call runs with `--ignore-user-config`,
       * so ~/.codex/config.toml does not count). The model that answered is stored in `ai_usage`.
       */
      model: nonEmptyString.optional(),
      /** G8: `-c model_reasoning_effort=`. Low is enough for scoring, signals and translation and is much faster. */
      reasoning_effort: z.enum(CODEX_REASONING_EFFORTS),
      /** Per-task override of `reasoning_effort`. */
      reasoning_effort_by_task: z.partialRecord(z.enum(AI_TASK_NAMES), z.enum(CODEX_REASONING_EFFORTS)),
      /**
       * G0: true = run Codex with a trimmed agent context (own system prompt as the base instructions, skills list and
       * environment text switched off; ~16k -> ~3k input tokens per call). false = system + user prompt on stdin, Codex's
       * default context. The tools are off either way.
       */
      trim_context: z.boolean(),
      /**
       * Extra Codex features switched off on every call (with or without trim_context), as `-c features.<name>=false` (an unknown
       * name is ignored by Codex). The ai-worker switches off every non-benign listed feature and a fixed tool list anyway
       * (`src/lib/ai/providers/cli-guards.ts`); this can only add names.
       */
      disable_features: z.array(codexKey),
      /**
       * Extra `-c key=value` overrides, passed with trim_context only. The ai-worker passes only context switches set to `false`
       * (`skills.include_instructions`, `agents.enabled`, `include_*_instructions`, `include_*_context`); other keys are dropped with a warning.
       */
      config_overrides: z.record(codexKey, tomlValue),
      /** G7: most codex-cli calls running at the same time in one process. */
      max_concurrency: positiveInt,
      /** G7: after a first `auth` failure wait this many seconds and retry once (token refresh race); 0 = no retry. */
      auth_retry_seconds: nonNegativeInt,
      /**
       * The oldest codex-cli this app works with: `codex exec --ignore-user-config --ignore-rules` (0.122.0) plus the options and
       * `codex features list` that are older still. `pnpm run doctor`, `pnpm ai:probe` and the ai-worker log a warning below it; an equal or
       * newer version is fine (what a newer Codex adds is switched off by the feature allowlist). Default: the shipped value.
       */
      min_version: codexMinVersion.default("0.122.0"),
      /** Removed: the exact-version comparison is gone. Still accepted from older user files and ignored. */
      verified_version: z.unknown().optional(),
    }),
    anthropic: z.strictObject({
      ...providerPolicy,
      /** Default (cheap) model. */
      model: nonEmptyString,
      /** Stronger model for harder tasks. */
      strong_model: nonEmptyString,
    }),
    deepseek: z.strictObject({
      ...providerPolicy,
      base_url: z.url(),
      model: nonEmptyString,
      /** DeepSeek has JSON mode only, no json_schema: the schema goes into the prompt. */
      json_mode_only: z.boolean(),
    }),
    mimo: z.strictObject({
      ...providerPolicy,
      base_url: z.url(),
      model: nonEmptyString,
      /** MiMo has JSON mode only, no json_schema. */
      json_mode_only: z.boolean(),
    }),
  }),
  tasks: z.strictObject({
    score: task,
    signals: task,
    translate: task,
    summarize: task,
    suggest: task,
    /** Optional in the file; parsed as {} (= the global order) when missing. */
    breakdown: task.default({}),
    /** The AI trap check; optional like `breakdown`. */
    traps: task.default({}),
    /**
     * The on-demand salary lookup, the one task allowed to search the web (`src/lib/ai/web-tasks.ts`). Optional; the
     * default leaves codex-cli out (its web search cannot be limited to domains): only providers that can search the web are tried.
     */
    salary_lookup: task.default({ order: ["claude-cli", "anthropic"] }),
  }),
  /** Request timeout for the API providers. */
  api_timeout_seconds: positiveInt,
  /** Upper bound on the tokens an API provider may generate per request. */
  max_output_tokens: positiveInt,
  /**
   * Quota / session-limit / rate-limit errors put the provider on cooldown for every process (runner, ai-worker):
   * it is skipped until the reset time the message names, else for `default_minutes`; never longer than `max_minutes`.
   */
  cooldown: z.strictObject({ default_minutes: positiveInt, max_minutes: positiveInt }),
  /** Job Radar's own usage cap for the subscription CLIs; absent in a file written before it existed = the shipped defaults. */
  quota_guard: quotaGuard.prefault({}),
  /** Wall-clock minutes of AI work (score, signals) one cycle may use before the rest waits for the next cycle; 0 = unlimited. */
  cycle_budget_minutes: nonNegativeInt,
  /** Same, for a cycle that found no new jobs (it only works off the backlog); 0 = unlimited. */
  idle_cycle_budget_minutes: nonNegativeInt,
  /** Max postings the AI layer handles per cycle. */
  per_cycle_limit: positiveInt,
  /** Monthly cap for paid API usage in USD. */
  monthly_api_budget_usd: nonNegativeNumber,
  /** Postings scoring at least this are translated automatically. */
  translate_auto_min_score: score0to100,
  scoring,
  translation,
}).superRefine((config, ctx) => {
  // A task may pick models only for providers its own order lists directly
  for (const name of AI_TASK_NAMES) {
    const t = config.tasks[name];
    if (!t.models) continue;
    if (!t.order) {
      ctx.addIssue({ code: "custom", path: ["tasks", name, "models"], message: "models needs the task's own order" });
      continue;
    }
    for (const key of Object.keys(t.models)) {
      if (!(t.order as readonly string[]).includes(key)) {
        ctx.addIssue({ code: "custom", path: ["tasks", name, "models", key], message: `provider "${key}" is not in tasks.${name}.order` });
      }
    }
  }
});

export type AiConfig = z.infer<typeof aiSchema>;
