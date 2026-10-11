import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Database schema v1.
 *
 * Conventions:
 * - Surrogate keys are `bigint` identity columns (mode "number": ids stay far below 2^53).
 *   `channels.id` is a human-readable text key and `email_messages.message_id` is the RFC 5322 id.
 * - All timestamps are `timestamptz`.
 * - Status-like fields are Postgres enums (adding a value is a cheap migration).
 * - Facts a posting does not state are stored as 'unknown' / NULL, never guessed (C3).
 */

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();

/** `tsvector` is not built in to drizzle; only ever produced by the generated column on `jobs`. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// ---------------------------------------------------------------- enums

export const jobStatusEnum = pgEnum("job_status", ["active", "possibly_closed", "closed"]);
export const applicationStatusEnum = pgEnum("application_status", [
  "new",
  "interested",
  "preparing",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "archived",
]);
export const parseStatusEnum = pgEnum("parse_status", ["pending", "parsed", "parse_failed"]);
export const cycleKindEnum = pgEnum("cycle_kind", ["weekday_morning", "weekday_evening", "weekend", "manual", "catchup"]);
export const runStatusEnum = pgEnum("run_status", ["running", "succeeded", "partial", "failed", "skipped"]);
export const channelHealthEnum = pgEnum("channel_health", ["unknown", "healthy", "degraded", "down"]);
export const circuitStateEnum = pgEnum("circuit_state", ["closed", "open", "half_open"]);
export const workplaceEnum = pgEnum("workplace", ["onsite", "hybrid", "remote", "unknown"]);
export const signalExtractorEnum = pgEnum("signal_extractor", ["rule", "ai"]);
/** Where a signal's quote comes from: the JD text, or a source's structured field (the salary field of a posting). */
export const signalQuoteSourceEnum = pgEnum("signal_quote_source", ["description", "structured"]);
export const filterResultEnum = pgEnum("filter_result", ["passed", "filtered_out"]);
export const filterOverrideEnum = pgEnum("filter_override", ["keep", "exclude"]);
export const profileKindEnum = pgEnum("profile_kind", ["me", "preferences", "interests"]);
export const suggestionStatusEnum = pgEnum("suggestion_status", ["pending", "approved", "rejected"]);

// ---------------------------------------------------------------- collection

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  family: text("family").notNull(),
  kind: text("kind").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  health: channelHealthEnum("health").notNull().default("unknown"),
  circuitState: circuitStateEnum("circuit_state").notNull().default("closed"),
  /** Free-form per-month usage counters (calls, cost) — shape owned by the channel layer. */
  monthUsage: jsonb("month_usage").notNull().default(sql`'{}'::jsonb`),
  /** Failed runs in a row; reset by a successful run. Drives the circuit breaker. */
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  /** While `circuit_state = open`: the time after which one probe run is allowed. */
  circuitOpenUntil: timestamptz("circuit_open_until"),
  lastErrorCode: text("last_error_code"),
  lastSuccessAt: timestamptz("last_success_at"),
  createdAt: createdAt(),
});

export const cycles = pgTable(
  "cycles",
  {
    id: id(),
    kind: cycleKindEnum("kind").notNull(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
    status: runStatusEnum("status").notNull().default("running"),
    summaryJson: jsonb("summary_json"),
  },
  (t) => [index("cycles_started_at_idx").on(t.startedAt)],
);

export const runs = pgTable(
  "runs",
  {
    id: id(),
    cycleId: bigint("cycle_id", { mode: "number" }).references(() => cycles.id, { onDelete: "set null" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    queryHash: text("query_hash"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
    status: runStatusEnum("status").notNull().default("running"),
    fetched: integer("fetched").notNull().default(0),
    /** Plan column `new`; renamed to avoid the SQL keyword. */
    newCount: integer("new_count").notNull().default(0),
    cost: numeric("cost", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    error: text("error"),
    /** Channel error classification (ChannelErrorCode) when the run failed or was skipped. */
    errorCode: text("error_code"),
  },
  (t) => [index("runs_cycle_id_idx").on(t.cycleId), index("runs_channel_started_idx").on(t.channelId, t.startedAt)],
);

/** C1: every fetched posting lands here verbatim before any parsing. */
export const rawPostings = pgTable(
  "raw_postings",
  {
    id: id(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    externalId: text("external_id").notNull(),
    url: text("url"),
    payloadJson: jsonb("payload_json").notNull(),
    /** SHA-256 of the canonical JSON payload: a re-fetched posting is re-parsed only if this changed. */
    payloadHash: text("payload_hash"),
    /** Last time the posting was returned by its channel (the first fetch for rows seen once). */
    fetchedAt: timestamptz("fetched_at").notNull().defaultNow(),
    parseStatus: parseStatusEnum("parse_status").notNull().default("pending"),
    /** Why the pipeline could not parse the payload (set with `parse_failed`, cleared when the payload changes). */
    parseError: text("parse_error"),
    runId: bigint("run_id", { mode: "number" }).references(() => runs.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("raw_postings_channel_external_uq").on(t.channelId, t.externalId),
    index("raw_postings_parse_status_idx").on(t.parseStatus),
    index("raw_postings_run_id_idx").on(t.runId),
  ],
);

/**
 * Per-board state of the ATS channels. The board is identified by the `ats_boards` (sources.yaml)
 * `ats` + `token`, not by a `companies` row (those are created by the pipeline, per company name).
 */
export const atsBoards = pgTable(
  "ats_boards",
  {
    ats: text("ats").notNull(),
    token: text("token").notNull(),
    /** Validator of the last complete response; sent as `If-None-Match`. NULL = no usable validator. */
    etag: text("etag"),
    /** Hash of everything that decided which postings were kept; a changed value invalidates the ETag. */
    filterFingerprint: text("filter_fingerprint"),
    /** External ids of the postings kept from the response `etag` belongs to (raw_postings.external_id). */
    externalIds: text("external_ids").array().notNull().default(sql`'{}'::text[]`),
    lastStatus: text("last_status").notNull(),
    lastErrorCode: text("last_error_code"),
    lastCheckedAt: timestamptz("last_checked_at").notNull().defaultNow(),
    /** Last time the board answered with new content (200). */
    lastChangedAt: timestamptz("last_changed_at"),
    /** Postings the board returned / kept by the title prefilter, at the last 200. */
    lastTotal: integer("last_total").notNull().default(0),
    lastKept: integer("last_kept").notNull().default(0),
    /** Checks in a row that failed (reset by a 200 or 304). Display only: it never stops a board or a channel. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Last time the board answered 200 or 304. */
    lastOkAt: timestamptz("last_ok_at"),
  },
  (t) => [primaryKey({ columns: [t.ats, t.token] })],
);

/**
 * The database mirror of config/sources.yaml (the file is the truth). One row per source entry: a channel
 * (id = channel id) or an ATS board (id = `board:<ats>:<token>`). Entries that leave the file are kept with
 * `in_config = false` and `removed_at`, and come back when they are added again.
 */
export const sourceRegistry = pgTable(
  "source_registry",
  {
    id: text("id").primaryKey(),
    /** `channel` | `ats_board`. */
    type: text("type").notNull(),
    sourceGroup: text("source_group").notNull(),
    name: text("name").notNull(),
    /** A board's ATS channel id. */
    parentId: text("parent_id"),
    enabled: boolean("enabled").notNull(),
    /** The entry's settings as of the last sync (a channel's config block, or `{ats, token, region?}`). */
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    inConfig: boolean("in_config").notNull().default(true),
    removedAt: timestamptz("removed_at"),
    /** Hash of the file text the row was synced from. */
    configHash: text("config_hash").notNull(),
    firstSyncedAt: timestamptz("first_synced_at").notNull().defaultNow(),
    syncedAt: timestamptz("synced_at").notNull().defaultNow(),
  },
  (t) => [
    index("source_registry_in_config_type_idx").on(t.inConfig, t.type),
    check("source_registry_type_check", sql`${t.type} in ('channel', 'ats_board')`),
  ],
);

/**
 * ATS boards that web-search discovery found but that are not in `ats_boards` of `config/sources.yaml`
 * yet. The user adds one from `/sources` (which writes sources.yaml) or dismisses it; discovery
 * itself never edits the config. One row per (ats, token), token compared as the ATS spells it.
 */
export const atsBoardCandidates = pgTable(
  "ats_board_candidates",
  {
    id: id(),
    ats: text("ats").notNull(),
    token: text("token").notNull(),
    /** Lever only: `eu` when the board was found on the EU host. */
    region: text("region"),
    /** The career-site URL the search result pointed at. */
    boardUrl: text("board_url").notNull(),
    /** Title of the (latest) search result; a hint for the company name. */
    title: text("title"),
    /** `new` = waiting for the user, `added` = put into sources.yaml, `dismissed` = not interested. */
    status: text("status").notNull().default("new"),
    seenCount: integer("seen_count").notNull().default(1),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    unique("ats_board_candidates_ats_token_key").on(t.ats, t.token),
    check("ats_board_candidates_status_check", sql`${t.status} in ('new', 'added', 'dismissed')`),
  ],
);

export const emailMessages = pgTable(
  "email_messages",
  {
    /** RFC 5322 Message-ID; the primary key is the required unique constraint. */
    messageId: text("message_id").primaryKey(),
    sender: text("sender").notNull(),
    receivedAt: timestamptz("received_at").notNull(),
    parseStatus: parseStatusEnum("parse_status").notNull().default("pending"),
    /** Pointer to the raw message (e.g. IMAP mailbox + UID); the body is not duplicated here. */
    rawRef: text("raw_ref"),
  },
  (t) => [index("email_messages_parse_status_idx").on(t.parseStatus)],
);

// ---------------------------------------------------------------- jobs

export const companies = pgTable(
  "companies",
  {
    id: id(),
    name: text("name").notNull(),
    nameNorm: text("name_norm").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    atsKind: text("ats_kind"),
    atsToken: text("ats_token"),
    watched: boolean("watched").notNull().default(false),
    blacklisted: boolean("blacklisted").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique("companies_name_norm_uq").on(t.nameNorm)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    companyId: bigint("company_id", { mode: "number" })
      .notNull()
      .references(() => companies.id),
    title: text("title").notNull(),
    titleNorm: text("title_norm").notNull(),
    locationsJson: jsonb("locations_json").notNull().default(sql`'[]'::jsonb`),
    workplace: workplaceEnum("workplace").notNull().default("unknown"),
    seniority: text("seniority").notNull().default("unknown"),
    contract: text("contract").notNull().default("unknown"),
    salaryJson: jsonb("salary_json"),
    description: text("description"),
    language: text("language").notNull().default("unknown"),
    germanLevelRequired: text("german_level_required").notNull().default("unknown"),
    postedAt: timestamptz("posted_at"),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    status: jobStatusEnum("status").notNull().default("active"),
    /** 64-bit SimHash of the description as a 16-char hex string (NULL for descriptions too short to hash). */
    simhash: text("simhash"),
    /** The poster is a recruiter / staffing agency rather than the employer (rule-based, see pipeline.yaml). */
    isAgency: boolean("is_agency").notNull().default(false),
    /** Skill names found in title + description by the `skills` patterns of pipeline.yaml. */
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    /** Last time maintenance checked the posting's links (rotates the possibly_closed link checks). */
    linkCheckedAt: timestamptz("link_checked_at"),
    /** What the last recheck of a watched job's posting found (`LinkCheckEvidence`: outcome, HTTP status, phrase, quote, URL, time). */
    linkCheckJson: jsonb("link_check_json"),
    /**
     * Full-text vector over title + description ('simple' config: postings are de/en mixed).
     * Postgres generated columns cannot reference another table, so the company name is not
     * part of the vector; company search joins on `companies.name_norm`.
     */
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))`,
    ),
  },
  (t) => [
    index("jobs_company_id_idx").on(t.companyId),
    index("jobs_status_last_seen_idx").on(t.status, t.lastSeenAt),
    index("jobs_title_norm_idx").on(t.titleNorm),
    index("jobs_simhash_idx").on(t.simhash),
    index("jobs_search_tsv_idx").using("gin", t.searchTsv),
  ],
);

export const jobSources = pgTable(
  "job_sources",
  {
    id: id(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    rawPostingId: bigint("raw_posting_id", { mode: "number" })
      .notNull()
      .references(() => rawPostings.id),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    /** The posting's page on the source. */
    url: text("url"),
    /** Where to apply when the source gives a separate link (NULL: apply via `url`). */
    applyUrl: text("apply_url"),
    /** Where this posting says the job is ("Berlin, Germany; Munich, Germany"), so the rows of a job with several postings can be told apart. */
    locationLabel: text("location_label"),
    /** Apply-link priority (lower wins): company ATS < LinkedIn < boards < aggregators. */
    priority: smallint("priority").notNull().default(100),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
  },
  (t) => [
    unique("job_sources_job_raw_posting_uq").on(t.jobId, t.rawPostingId),
    index("job_sources_raw_posting_id_idx").on(t.rawPostingId),
  ],
);

// ---------------------------------------------------------------- analysis

export const signals = pgTable(
  "signals",
  {
    id: id(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /** The signal category id of interests.yaml (user-defined; the default ids are T1-T4 and tag). */
    tier: text("tier").notNull(),
    kind: text("kind").notNull(),
    valueJson: jsonb("value_json"),
    /** C7: no quote, no signal. */
    quote: text("quote").notNull(),
    /** Where `quote` sits in the JD; NULL for a `structured` quote (it is the source field's own text, not part of the JD). */
    quoteOffset: integer("quote_offset"),
    quoteSource: signalQuoteSourceEnum("quote_source").notNull().default("description"),
    extractor: signalExtractorEnum("extractor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("signals_job_id_idx").on(t.jobId),
    check("signals_quote_not_empty", sql`length(btrim(${t.quote})) > 0`),
    // the same format as interests.yaml category ids (`SIGNAL_CATEGORY_ID`)
    check("signals_tier_format", sql`${t.tier} ~ '^[A-Za-z][A-Za-z0-9_-]{0,23}$'`),
  ],
);

/**
 * What the `signals` step has done for a job: which JD text and which vocabulary the rule
 * signals were computed from, and whether / with what the AI reviewed them. A job whose JD or the
 * vocabulary changed is scanned again; a job reviewed by the AI is not sent again until the JD or
 * the prompt version changes. One row per job.
 */
export const signalScans = pgTable("signal_scans", {
  jobId: bigint("job_id", { mode: "number" })
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" }),
  /** md5 of `jobs.description` when the rule signals were computed. */
  descriptionHash: text("description_hash").notNull(),
  /** Hash of the vocabulary and salary config the rule signals were computed with. */
  rulesHash: text("rules_hash").notNull(),
  /** md5 of the job's `salary_json` text when its salary signal was computed; NULL = not yet (the salary signal follows the salary without a rescan). */
  salaryHash: text("salary_hash"),
  scannedAt: timestamptz("scanned_at").notNull().defaultNow(),
  /** How many T1-T4 candidates the rules found (decides which jobs the AI reads first). */
  candidateCount: integer("candidate_count").notNull().default(0),
  /** md5 of the JD the AI reviewed; NULL = not reviewed yet. */
  aiDescriptionHash: text("ai_description_hash"),
  aiPromptVersion: text("ai_prompt_version"),
  aiProvider: text("ai_provider"),
  aiModel: text("ai_model"),
  aiScannedAt: timestamptz("ai_scanned_at"),
});

export const profileSnapshots = pgTable(
  "profile_snapshots",
  {
    id: id(),
    kind: profileKindEnum("kind").notNull(),
    contentYaml: text("content_yaml").notNull(),
    hash: text("hash").notNull(),
    savedAt: timestamptz("saved_at").notNull().defaultNow(),
  },
  (t) => [unique("profile_snapshots_kind_hash_uq").on(t.kind, t.hash)],
);

export const scores = pgTable(
  "scores",
  {
    id: id(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    profileSnapshotId: bigint("profile_snapshot_id", { mode: "number" }).references(() => profileSnapshots.id),
    provider: text("provider"),
    model: text("model"),
    filterResult: filterResultEnum("filter_result").notNull(),
    filterReasons: text("filter_reasons").array().notNull().default(sql`'{}'::text[]`),
    /**
     * The match score after the German deduction: `ai_score - german_penalty`, within 0..100.
     * NULL until the AI has scored the job (filtered-out jobs are never scored).
     */
    score: smallint("score"),
    /** What the model answered, before the German deduction. */
    aiScore: smallint("ai_score"),
    /** Points taken off `ai_score` because the posting requires more German than me.yaml has. */
    germanPenalty: smallint("german_penalty").notNull().default(0),
    /** German level used for the deduction: the rule value of the pipeline cross-checked with the AI's reading. */
    germanLevel: text("german_level"),
    /** The AI's own reading of the German level the JD requires. */
    germanLevelAi: text("german_level_ai"),
    /** How `german_level` was settled: agree / rule / ai / rule_explicit / ai_explicit / rule_preferred. */
    germanLevelSource: text("german_level_source"),
    /** Version of the scoring prompt that produced the score (`SCORE_PROMPT_VERSION`); another version => stale. */
    promptVersion: text("prompt_version"),
    scoredAt: timestamptz("scored_at"),
    signalBonus: numeric("signal_bonus", { precision: 6, scale: 2, mode: "number" }).notNull().default(0),
    rankValue: numeric("rank_value", { precision: 6, scale: 2, mode: "number" }),
    fitReasons: text("fit_reasons").array().notNull().default(sql`'{}'::text[]`),
    gaps: text("gaps").array().notNull().default(sql`'{}'::text[]`),
    /** Kept and still written for a rollback; read `summaries`. Dropped in a later clean-up. */
    summaryZh: text("summary_zh"),
    summaryEn: text("summary_en"),
    /** The one-line summary per language (`{ "zh": "…", "en": "…" }`): `language.yaml` ai.output plus ai.summary_also. */
    summaries: jsonb("summaries").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** The language of `fit_reasons`, `gaps` and the summary in that language (a BCP 47 code); null before the AI scored. */
    outputLang: text("output_lang"),
    stale: boolean("stale").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("scores_job_id_idx").on(t.jobId),
    index("scores_rank_value_idx").on(t.rankValue),
    /** One result per (job, profile snapshot); rows without a snapshot (seed data) are not constrained. */
    uniqueIndex("scores_job_snapshot_uq")
      .on(t.jobId, t.profileSnapshotId)
      .where(sql`${t.profileSnapshotId} is not null`),
    check("scores_score_range", sql`${t.score} is null or ${t.score} between 0 and 100`),
  ],
);

export const translations = pgTable(
  "translations",
  {
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    lang: text("lang").notNull(),
    provider: text("provider"),
    content: text("content").notNull(),
    /** SHA-256 (hex) of the job description this translation was made from; a different hash on the job = outdated. */
    sourceHash: text("source_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.lang] })],
);

/**
 * The AI breakdown of a job's JD (responsibilities, tech stack by category, experience, projects, soft skills,
 * languages, other), one row per job, replaced when the job is broken down again. An AI reading, never a fact of the
 * job (C3): nothing here is copied into `jobs`. Every item carries a verbatim JD quote and its offset (C7).
 * `content` is validated with the zod schema of `prompt_version` when read (`parseStoredBreakdown`).
 */
export const jobBreakdowns = pgTable("job_breakdowns", {
  jobId: bigint("job_id", { mode: "number" })
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" }),
  /** SHA-256 (hex) of `jobs.description` at the time; another hash on the job = the JD changed since. */
  sourceHash: text("source_hash").notNull(),
  /** `BREAKDOWN_PROMPT_VERSION` of the prompt and output schema that produced `content`. */
  promptVersion: text("prompt_version").notNull(),
  provider: text("provider"),
  model: text("model"),
  content: jsonb("content").notNull(),
  /** Items the model returned whose quote is not in the JD (dropped, C7). */
  droppedItems: integer("dropped_items").notNull().default(0),
  /** The language the items are written in (a BCP 47 code). */
  outputLang: text("output_lang").notNull(),
  analyzedAt: timestamptz("analyzed_at").notNull().defaultNow(),
});

/**
 * The salary benchmark, rebuilt after each pipeline step from the stated salaries of the window (and, optionally,
 * checked AI lookup bands): one row per group that reached `salary.yaml: benchmark.min_sample`. `seniority` `*` = any
 * seniority; `geo_level` city / country / all (`geo_key` the lower-case city, the ISO country code, or `*`). Figures are
 * per year in `currency` (the market's base currency when it was built).
 */
export const salaryBenchmarks = pgTable(
  "salary_benchmarks",
  {
    id: id(),
    roleFamily: text("role_family").notNull(),
    seniority: text("seniority").notNull(),
    geoLevel: text("geo_level").notNull(),
    geoKey: text("geo_key").notNull(),
    currency: text("currency").notNull(),
    /** Figures in the group, AI lookup bands included. */
    n: integer("n").notNull(),
    /** Of those, AI lookup bands. */
    nAi: integer("n_ai").notNull().default(0),
    median: numeric("median", { precision: 14, scale: 2, mode: "number" }).notNull(),
    /** [p10, p20, ..., p90]. */
    quantiles: jsonb("quantiles").notNull(),
    refreshedAt: timestamptz("refreshed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("salary_benchmarks_group_uq").on(t.roleFamily, t.seniority, t.geoLevel, t.geoKey, t.currency)],
);

/**
 * on-demand AI salary lookups (AI estimates from public web pages, C3: never written into `jobs`). `lookup_key`
 * = normalised company | family | title | seniority | country | city: the cache key. `result_json` is the checked
 * answer (sources with URLs, bands, confidence); a failed lookup keeps its `error_code` and is never served from the cache.
 */
export const salaryLookups = pgTable(
  "salary_lookups",
  {
    id: id(),
    companyId: bigint("company_id", { mode: "number" })
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id, { onDelete: "set null" }),
    lookupKey: text("lookup_key").notNull(),
    status: text("status").notNull(),
    resultJson: jsonb("result_json"),
    confidence: text("confidence"),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    errorCode: text("error_code"),
    fetchedAt: timestamptz("fetched_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [
    index("salary_lookups_key_idx").on(t.lookupKey, t.fetchedAt.desc()),
    index("salary_lookups_fetched_idx").on(t.fetchedAt),
    // the foreign keys' cascades (a company or job deleted) look rows up by these
    index("salary_lookups_job_idx").on(t.jobId),
    index("salary_lookups_company_idx").on(t.companyId),
  ],
);

/** Which layer found an AI trap, how serious it is, and where its quote comes from. */
export const trapLayerEnum = pgEnum("trap_layer", ["rule", "ai"]);
export const trapSeverityEnum = pgEnum("trap_severity", ["trap", "suspicious"]);
export const trapQuoteSourceEnum = pgEnum("trap_quote_source", ["description", "raw"]);

/**
 * Content of a JD written to mislead an AI (hidden text, instructions to an AI, invisible characters), one row per
 * finding. A marker only (C3): nothing here changes the score, the facts or the filter. C7: every row carries a verbatim quote and
 * its place: an offset in `jobs.description`, or (`quote_source = raw`) the field path of the source payload in `location`.
 * `technique` / `method` / `ai_verdict` are text validated by zod (`@/lib/traps/types`).
 */
export const jobTraps = pgTable(
  "job_traps",
  {
    id: id(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    rawPostingId: bigint("raw_posting_id", { mode: "number" }).references(() => rawPostings.id, { onDelete: "set null" }),
    layer: trapLayerEnum("layer").notNull(),
    technique: text("technique").notNull(),
    method: text("method"),
    severity: trapSeverityEnum("severity").notNull(),
    quote: text("quote").notNull(),
    quoteSource: trapQuoteSourceEnum("quote_source").notNull(),
    quoteOffset: integer("quote_offset"),
    /** `description`, or `raw:<field path>` (`raw:posting.content`, `raw:descriptionHtml@alt`). */
    location: text("location").notNull(),
    /** The markup that hides it (`style="color:#ffffff"`). */
    evidence: text("evidence"),
    /** `instruction_id`, the decoded text of tag characters, counts. */
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    /** The AI check's view of a rule finding: confirmed / benign / disputed (a rule trap the AI doubts stays a trap). */
    aiVerdict: text("ai_verdict"),
    /** The AI's reason (AI findings and judged rule findings). */
    reason: text("reason"),
    /** The quote is part of `jobs.description` (it reached the AI before trap detection removed it). */
    inDescription: boolean("in_description").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("job_traps_job_id_idx").on(t.jobId),
    check("job_traps_quote_not_empty", sql`length(btrim(${t.quote})) > 0`),
    check("job_traps_evidence_length", sql`${t.evidence} is null or length(${t.evidence}) <= 200`),
  ],
);

/**
 * The trap scan of a job (like `signal_scans`): which JD, which source payloads and which rules the rule findings come
 * from (a change of any of the three rescans), the counts the lists show, and whether / with what the AI checked it.
 */
export const trapScans = pgTable(
  "trap_scans",
  {
    jobId: bigint("job_id", { mode: "number" })
      .primaryKey()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /** md5 of `coalesce(jobs.description, '')` at the scan. */
    descriptionHash: text("description_hash").notNull(),
    /** md5 of the job's `raw_posting_id:payload_hash` list. */
    sourcesHash: text("sources_hash").notNull(),
    /** `rulesFingerprint` of traps.yaml. */
    rulesHash: text("rules_hash").notNull(),
    scannedAt: timestamptz("scanned_at").notNull().defaultNow(),
    /** Findings with severity `trap` (rule and AI). */
    trapCount: integer("trap_count").notNull().default(0),
    /** Findings with severity `suspicious` the AI did not judge harmless. */
    suspiciousCount: integer("suspicious_count").notNull().default(0),
    /** The rules found something (or a trigger matched): the `flagged` AI check looks at the job. */
    needsAi: boolean("needs_ai").notNull().default(false),
    /** Hash of the JD pieces removed from the AI input; null = none. */
    spansHash: text("spans_hash"),
    /** When the current `spans_hash` first appeared: a score made before it read the trap. */
    foundAt: timestamptz("found_at"),
    /** md5 of the JD the AI checked; NULL = not checked. */
    aiDescriptionHash: text("ai_description_hash"),
    aiPromptVersion: text("ai_prompt_version"),
    aiProvider: text("ai_provider"),
    aiModel: text("ai_model"),
    aiCheckedAt: timestamptz("ai_checked_at"),
  },
  (t) => [index("trap_scans_trap_count_idx").on(t.trapCount).where(sql`${t.trapCount} > 0`)],
);

/**
 * What a job's JD says about visa sponsorship / a work permit (rules only), one row per scanned job. A marker only (C3): nothing
 * here changes a score or filters a job. C7: every evidence item (`[{status, kind, quote, offset}]`, validated by zod in
 * `@/lib/visa/types`) is a verbatim quote of `jobs.description` and its offset. `input_hash` covers the JD, the rules and the
 * other inputs of the check (see `@/lib/visa/step`): a different hash rescans the job.
 */
export const jobVisa = pgTable(
  "job_visa",
  {
    jobId: bigint("job_id", { mode: "number" })
      .primaryKey()
      .references(() => jobs.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    inputHash: text("input_hash").notNull(),
    checkedAt: timestamptz("checked_at").notNull().defaultNow(),
  },
  (t) => [
    check("job_visa_status_check", sql`${t.status} in ('offered', 'not_offered', 'unclear', 'not_mentioned')`),
    check("job_visa_evidence_check", sql`${t.status} = 'not_mentioned' or jsonb_array_length(${t.evidence}) > 0`),
  ],
);

/**
 * A translation that is not finished: a long JD is translated piece by piece, and every piece that came back is
 * kept here so a failure (timeout, provider down) costs only the pieces that are missing. `chunks` is the list of
 * finished pieces (`index`, Chinese `content` in stored form, `provider`, token counts). The row belongs to one
 * version of the description (`source_hash`) and one way of cutting it (`total_chunks`); it is deleted once the
 * whole translation is in `translations`.
 */
export const translationProgress = pgTable(
  "translation_progress",
  {
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    lang: text("lang").notNull(),
    sourceHash: text("source_hash").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    chunks: jsonb("chunks").notNull().default(sql`'[]'::jsonb`),
    /** Why the last attempt stopped: `{ chunk, code, message }`; null while nothing failed. */
    lastError: jsonb("last_error"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.lang] })],
);

// ---------------------------------------------------------------- applications

export const applications = pgTable(
  "applications",
  {
    id: id(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id),
    status: applicationStatusEnum("status").notNull().default("new"),
    statusChangedAt: timestamptz("status_changed_at").notNull().defaultNow(),
    nextAction: text("next_action"),
    nextActionAt: timestamptz("next_action_at"),
    notesMd: text("notes_md"),
    resumeVariantPath: text("resume_variant_path"),
    /** Interview rounds held so far (the pipeline board's +/- counter). */
    interviewRounds: integer("interview_rounds").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique("applications_job_id_uq").on(t.jobId), index("applications_status_idx").on(t.status)],
);

/**
 * The user's decision about the hard filter for one job: `keep` = keep a filtered job, `exclude` =
 * filter a job that passed. Per job, not per profile snapshot, so it survives re-filtering and new
 * preference snapshots; the filter step applies it.
 */
export const jobFilterOverrides = pgTable("job_filter_overrides", {
  jobId: bigint("job_id", { mode: "number" })
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" }),
  action: filterOverrideEnum("action").notNull(),
  createdAt: createdAt(),
});

/**
 * The user's star on a job: independent of the application status, so a job can be applied
 * and starred. Adding / removing one touches nothing else (no `applications` row, no event, no
 * score). `note` is a short free-text line shown on the favorites page only.
 */
export const jobFavorites = pgTable(
  "job_favorites",
  {
    jobId: bigint("job_id", { mode: "number" })
      .primaryKey()
      .references(() => jobs.id, { onDelete: "cascade" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("job_favorites_created_at_idx").on(t.createdAt)],
);

/** The user's own judgement: `closed` = I confirm it is closed; `open` = I confirm it is still open (overrides the checks). */
export const closureOverrideEnum = pgEnum("closure_override", ["closed", "open"]);

/** One judgement per job; the automatic `jobs.status` is left alone (the lifecycle step recomputes it every cycle). */
export const jobClosureOverrides = pgTable("job_closure_overrides", {
  jobId: bigint("job_id", { mode: "number" })
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" }),
  action: closureOverrideEnum("action").notNull(),
  /** Optional note (up to 200 characters, `CLOSURE_NOTE_MAX`). */
  note: text("note"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** How a job came to be seen: the detail page shown, its posting opened, an action on its row, "mark all seen", or the upgrade's backfill. */
export const jobSeenViaEnum = pgEnum("job_seen_via", ["detail", "source", "action", "bulk", "migration"]);

/**
 * The jobs the user has looked at (one row per seen job; no row = unseen, shown bold with a dot). The user's own state,
 * like `job_favorites`, never a fact of the job: the first sighting is kept (`seen_at` is not moved by a later look), "mark as
 * unseen" deletes the row. A "mark all seen" batch shares one `seen_at` with `via = 'bulk'`, which is how its undo finds it.
 */
export const jobSeen = pgTable(
  "job_seen",
  {
    jobId: bigint("job_id", { mode: "number" })
      .primaryKey()
      .references(() => jobs.id, { onDelete: "cascade" }),
    seenAt: timestamptz("seen_at").notNull().defaultNow(),
    via: jobSeenViaEnum("via").notNull(),
  },
  (t) => [index("job_seen_via_seen_at_idx").on(t.via, t.seenAt)],
);

export const applicationEvents = pgTable(
  "application_events",
  {
    id: id(),
    applicationId: bigint("application_id", { mode: "number" })
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    at: timestamptz("at").notNull().defaultNow(),
    fromStatus: applicationStatusEnum("from_status"),
    toStatus: applicationStatusEnum("to_status").notNull(),
    note: text("note"),
  },
  (t) => [index("application_events_application_at_idx").on(t.applicationId, t.at)],
);

// ---------------------------------------------------------------- ops

/**
 * One row per model call: successful, invalid-output and failed calls alike (aborted and skipped ones are not calls).
 * NULL means unknown, never 0: `tokens_in` / `tokens_out` and the detail columns are NULL when the provider did not
 * report usage; rows written before AI usage tracking have NULL in every column added by it ("legacy rows").
 * Token convention (all four transports): `tokens_in` is all input including `tokens_in_cached` and
 * `tokens_in_cache_write`; `tokens_out` is all output including `tokens_out_reasoning`.
 * `model_source`: `call` (reported by the call or chosen by us), `cli_default` (codex default model from the catalog),
 * `assumed` (a model assumed for old rows by an earlier version). `outcome`: `ok` | `invalid_output` | `failed`; `error_kind` only on failed rows.
 * `cost_estimate` is the actual spend (0 for subscriptions; what the monthly budget sums); `equivalent_cost_usd` is what the
 * same tokens cost at API list prices (NULL = unknown). Both are computed at write time and never recomputed.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: id(),
    provider: text("provider").notNull(),
    task: text("task").notNull(),
    model: text("model"),
    modelSource: text("model_source"),
    tokensIn: integer("tokens_in"),
    tokensInCached: integer("tokens_in_cached"),
    tokensInCacheWrite: integer("tokens_in_cache_write"),
    tokensOut: integer("tokens_out"),
    tokensOutReasoning: integer("tokens_out_reasoning"),
    durationMs: integer("duration_ms"),
    outcome: text("outcome"),
    errorKind: text("error_kind"),
    costEstimate: numeric("cost_estimate", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    equivalentCostUsd: numeric("equivalent_cost_usd", { precision: 12, scale: 6, mode: "number" }),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id, { onDelete: "set null" }),
    at: timestamptz("at").notNull().defaultNow(),
  },
  (t) => [index("ai_usage_at_idx").on(t.at), index("ai_usage_job_id_idx").on(t.jobId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    kind: text("kind").notNull(),
    cycleId: bigint("cycle_id", { mode: "number" }).references(() => cycles.id, { onDelete: "set null" }),
    payloadJson: jsonb("payload_json"),
    sentAt: timestamptz("sent_at"),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
  },
  (t) => [index("notifications_cycle_id_idx").on(t.cycleId)],
);

/**
 * Weekly AI suggestions for the interests list. `kind` is `signal_word`, `watched_company` or `filter`;
 * `payload_json` holds the suggestion with its evidence (src/lib/interests/suggestion.ts). `dedupe_key` names
 * what is suggested, whatever its status: a suggestion that was decided (or is still pending) is never proposed again.
 */
export const interestSuggestions = pgTable(
  "interest_suggestions",
  {
    id: id(),
    kind: text("kind").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    status: suggestionStatusEnum("status").notNull().default("pending"),
    createdAt: createdAt(),
    dedupeKey: text("dedupe_key").notNull(),
    decidedAt: timestamptz("decided_at"),
  },
  (t) => [index("interest_suggestions_status_idx").on(t.status), unique("interest_suggestions_dedupe_key_uq").on(t.dedupeKey)],
);

export const runnerHeartbeats = pgTable(
  "runner_heartbeats",
  {
    id: id(),
    process: text("process").notNull(),
    at: timestamptz("at").notNull().defaultNow(),
  },
  (t) => [index("runner_heartbeats_at_idx").on(t.at)],
);

// ---------------------------------------------------------------- web -> runner control

export const controlRequestKindEnum = pgEnum("control_request_kind", ["run_cycle", "rescore_stale", "run_suggest", "run_ai", "translate_job", "breakdown_job", "score_jobs", "test_channel", "test_ai", "test_telegram", "salary_lookup"]);
export const controlRequestStatusEnum = pgEnum("control_request_status", ["pending", "running", "done", "failed"]);

/**
 * Requests the web app leaves for the runner (it opens no port): the runner polls this table,
 * claims one request at a time and records the outcome. `payload` depends on `kind`
 * (`run_cycle`: optional channel ids), `result` is what the handler reported. Which process claims
 * a request depends on `kind`: the runner takes `run_cycle`; the ai-worker on the host takes
 * `run_ai` (the delegated `ai` + `notify` steps of a cycle) and, with `ai.yaml: execution: host`,
 * `translate_job`, `breakdown_job` and `rescore_stale` too.
 */
export const controlRequests = pgTable(
  "control_requests",
  {
    id: id(),
    kind: controlRequestKindEnum("kind").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: controlRequestStatusEnum("status").notNull().default("pending"),
    result: jsonb("result"),
    requestedAt: timestamptz("requested_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [index("control_requests_status_idx").on(t.status, t.id)],
);

/**
 * Small key/value state the runner publishes for the web app. Today: `config_loaded:<name>`, the
 * hash of the config file text the runner last loaded (the settings page compares it with the file
 * on disk to show "runner has loaded this"). The web app keeps `ui:visit` here too: when the user last
 * looked at Today / /jobs (the "new since last visit" dots).
 */
export const runtimeState = pgTable("runtime_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});
