/**
 * What the settings forms edit: per config file, the sections and fields, each addressed by
 * its dotted path in the YAML. The zod schemas stay the single source of truth for what is valid
 * (C8); this table only says which key is shown how. `tests/settings/fields.test.ts` keeps it in
 * step with the shipped YAML: every key is either a field here or listed in `HIDDEN_PATHS`.
 *
 * Pure data, no server-only imports: the client form and the server action share it.
 */
import type messages from "../../../messages/en.json";
import { LOCALES } from "../../i18n/catalog.generated";
import { AI_API_PROVIDERS, type AiProviderIdChoice, AI_PROVIDER_KINDS, AI_TASK_NAMES, AI_TASK_PROVIDERS, CODEX_REASONING_EFFORTS } from "../config/ai-options";
import { BREAKDOWN_MODES } from "../config/breakdown-options";
import { consentKind } from "../channels/access";
import { isProtectedPath } from "../config/protected-keys";
import type { SettingsForm } from "./tabs";

type SettingsMessages = (typeof messages)["settings"];
/** Keys of `settings.fields` in the messages files: the label of a field; a `hint` entry there is shown under the control. */
export type FieldLabelId = keyof SettingsMessages["fields"];
/** `settings.sections.<id>` is the title; a `settings.sectionHints.<id>` entry adds a description line. */
export type SectionId = keyof SettingsMessages["sections"];
export type OptionGroupId = keyof SettingsMessages["options"];
/** Labels of the empty choice of an optional dropdown (`settings.controls.<id>`). */
export type EmptyOptionId = "cliDefault" | "inheritEffort" | "followUi";

export type FieldKind =
  | "bool"
  /** Whole number; edited as text so a half-typed value is not lost. */
  | "int"
  | "number"
  | "text"
  | "select"
  /** One model out of the provider's catalog (`models.yaml`, `provider` of the def). */
  | "model"
  /** List of short strings (type + Enter). */
  | "tags"
  /** List of numbers, edited like tags (each entry is parsed as a decimal). */
  | "numberList"
  /** Ordered subset of `options` (up / down / remove / add). */
  | "ordered"
  /** `search.yaml: keyword_groups` — group id → keywords. */
  | "keywordGroups"
  /** `ai.yaml: tasks.<task>` as a whole — the ordered providers of the task, each with an optional model of its own. */
  | "route"
  /** A remote scope (`none` / `home_country` / `worldwide` / a list of regions and countries), edited as its scope key. */
  | "remoteScope";

export interface FieldDef {
  /** Dotted path in the config value, e.g. `linkedin.brightdata.throttle.min_delay_ms`. */
  path: string;
  kind: FieldKind;
  label: FieldLabelId;
  /** text / ordered: empty means "key absent" instead of an error. */
  optional?: boolean;
  /** text: empty means `null` (the key stays, with no value). */
  nullable?: boolean;
  /** select / ordered: the values offered. */
  options?: readonly string[];
  /** select: where the option labels live (`settings.options.<group>`); omitted = the value itself. */
  optionGroup?: OptionGroupId;
  /** model: the provider whose catalog entries are the choices. */
  provider?: AiProviderIdChoice;
  /** select (codex reasoning effort): offer only the efforts the model chosen in the field at this path supports. */
  effortModelPath?: string;
  /** select / model with `optional`: label of the empty choice (the key is left out). */
  emptyOption?: EmptyOptionId;
  /** ordered / select: the options are AI providers; the page marks the ones that cannot run now. */
  aiProviders?: boolean;
  /** Monospace text (URLs, ids, cron). */
  mono?: boolean;
  /** A rarely changed field, folded under "more" in its provider card. */
  advanced?: boolean;
  /** text: a 5-field cron expression; the form shows what it means ("weekdays 07:00") next to the box. */
  cron?: boolean;
  /** select: the options are interface languages, shown by their own names (`meta.name`). */
  localeOptions?: boolean;
  /** text / tags: every value is a language code (`en`, `pt-BR`); the form flags a bad one while typing and blocks the save. */
  languageCode?: boolean;
  /**
   * tags / numberList: how the tag box treats an entry that is already in the list. `insensitive` (tags default) ignores case,
   * `exact` compares the text as typed (numberList default), `none` allows repeats (a list where a repeat means something).
   */
  dedupe?: "insensitive" | "exact" | "none";
  /** tags: a comma ends an entry (default). Off for fields whose entries are whole sentences. */
  commitOnComma?: boolean;
  /** A protected key (`config/protected-keys.ts`): shown read-only, changed only by editing the file. Set by `SETTINGS_SECTIONS`. */
  locked?: boolean;
}

/** Units drawn inside number boxes (`settings.units.<id>`). */
export type FieldUnit = "hours" | "minutes" | "seconds" | "ms" | "days" | "weeks" | "mb" | "km" | "keur";

/** Ordered: the first pattern that matches the last segment of the path wins. The key names carry their unit, so there is no second table to keep in step. */
const UNIT_PATTERNS: readonly (readonly [RegExp, FieldUnit])[] = [
  [/(^|_)ms$/, "ms"],
  [/(^|_)(seconds|secs)$/, "seconds"],
  [/(^|_)minutes$/, "minutes"],
  [/(^|_)hours$/, "hours"],
  [/(^|_)days$|^keep_daily$/, "days"],
  [/^keep_weekly$/, "weeks"],
  [/(^|_)mb$/, "mb"],
  [/(^|_)km$/, "km"],
  [/(^|_)k$/, "keur"],
];

/** The unit of a numeric field, from its key (`timeout_ms` -> ms, `window_hours.morning` -> hours); null when it has none. */
export function fieldUnit(path: string): FieldUnit | null {
  const segments = path.split(".");
  const last = segments[segments.length - 1] ?? "";
  // `window_hours.morning`: the unit is on the parent key
  const keys = /^(morning|evening|weekend)$/.test(last) && segments.length > 1 ? [segments[segments.length - 2] ?? last] : [last];
  for (const key of keys) for (const [pattern, unit] of UNIT_PATTERNS) if (pattern.test(key)) return unit;
  return null;
}

/**
 * The currency sign drawn in front of a money box, from the key (`monthly_budget_usd` -> `$`, `*_eur` -> `€`); null when the field is
 * not money. The sign follows the field's currency, so a dollar cap never reads as euros.
 */
export function fieldPrefix(path: string): "$" | "€" | null {
  const last = path.split(".").pop() ?? "";
  if (/(^|_)usd$/.test(last)) return "$";
  if (/(^|_)eur(_year)?$/.test(last)) return "€";
  return null;
}

/** The AI tab's four blocks, in page order. */
export const AI_BLOCKS = ["providers", "routing", "limits", "scoring"] as const;
export type AiBlockId = (typeof AI_BLOCKS)[number];

export interface SectionDef {
  /** Stable DOM / test id. */
  id: string;
  /** (AI tab) Which of the four blocks the section belongs to. */
  block?: AiBlockId;
  title: { section: SectionId } | { text: string };
  /** Rendered as a collapsible block (one per channel); the rest are plain groups. */
  collapsible?: boolean;
  /** Dotted path of the `enabled` field shown in a collapsed section's summary. */
  enabledPath?: string;
  /** The provider whose model catalog table closes the section and whose label the title shows. */
  catalogProvider?: AiProviderIdChoice;
  /** Dotted path of the model field shown as a badge in a collapsed section's title. */
  modelPath?: string;
  fields: FieldDef[];
}

/**
 * Keys that exist in the YAML but are deliberately not shown (kept untouched on save).
 * Files that are not a settings tab at all (pipeline.yaml with its hard filter, dedupe and salary rules,
 * interests.yaml) are edited in the YAML or on their own pages.
 */
export const HIDDEN_PATHS: Record<SettingsForm, readonly string[]> = {
  // The weekly suggestion's switch, cron, Telegram note and the main limits have a form; the keys that only size its prompt
  // (which statuses count as liked / ignored, how many jobs and characters go to the AI, evidence counts) stay in the YAML.
  // The `pnpm run doctor` checks and the Docker housekeeping of scripts/ops/deploy.sh (read by the script) are operations
  // parameters: edited in the YAML or in the advanced editor. So is the processes' log level (`logging`, schema default only).
  schedule: ["suggest.positive_statuses", "suggest.ignored_statuses", "suggest.min_positive_jobs", "suggest.max_positive_jobs", "suggest.max_ignored_jobs", "suggest.jd_max_chars", "suggest.min_evidence", "suggest.max_term_chars", "doctor", "deploy", "backup.keep_old_databases", "logging"],
  search: [],
  // Proxy URLs can carry credentials: edit them in the YAML, never render them in the page.
  // The Apify and Monid actors' wire formats (input template, look-back filter values) are actor-specific JSON-like data: edit it in the YAML.
  // The LinkedIn session channel's site and browser details (login file path, locations, timeouts, scrolling) are edited in the YAML.
  // The size of a channel test is edited in the YAML.
  // The ATS company boards (`ats_boards`) and the source registry settings (`registry`) are edited on /sources/registry or in the YAML.
  channels: [
    "ats_boards",
    "registry",
    "test_channel",
    "jobspy.proxies",
    "linkedin.apify.date_posted",
    "linkedin.apify.input_template",
    "linkedin.apify.remote_input",
    "linkedin.monid.date_posted",
    "linkedin.monid.input_template",
    "linkedin.monid.remote_input",
    "linkedin.session.site",
    "linkedin.session.browser",
    "linkedin.session.recommended_max_results",
    // Which markets a channel serves is pack data, edited in the YAML
    "sources.arbeitsagentur.markets",
    "sources.stepstone.markets",
    "sources.xing.markets",
    "sources.arbeitnow.markets",
  ],
  // Where the AI runs and the host worker's timings are edited in the YAML (operations parameters, machine paths).
  // The pre-score weights and tables (`scoring.priority`) are a form in the "scoring" block.
  // The codex-cli context trimming, concurrency and version keys are edited in the YAML too; its effort is a dropdown.
  ai: [
    "execution",
    "host_worker",
    "translation",
    "providers.codex_cli.trim_context",
    "providers.codex_cli.disable_features",
    "providers.codex_cli.config_overrides",
    "providers.codex_cli.max_concurrency",
    "providers.codex_cli.auth_retry_seconds",
    "providers.codex_cli.min_version",
    "providers.codex_cli.verified_version", // removed key, still accepted from older files
  ],
  breakdown: [],
  // The role families, deep link templates, trusted domains and the sanity range are lists / tables: the advanced editor
  salary: ["role_families", "deep_links", "lookup.allowed_fetch_domains", "lookup.sanity_annual", "lookup.unconvertible_max_annual", "lookup.web_search_usd", "lookup.max_searches"],
  // The two reminder thresholds are edited in the "application workflow" tab, next to the statuses they belong to.
  // telegram.setup: waits of the host command `pnpm run setup --step telegram`, edited in the YAML or the advanced editor.
  notify: ["reminders.interested_days", "reminders.applied_days", "telegram.setup"],
  // The hidden statuses / categories are the workflow tab's status table; the editor's own limits are in the advanced editor.
  // web_access (the login limits) is a protected key: changed in the file only, never from the dashboard.
  // The job checks (the recheck of watched jobs, the visa check) are edited in the YAML or the advanced editor.
  ui: ["applications", "filters", "companies", "config_editor", "web_access", "job_checks"],
  insights: [],
  resume: [],
  language: [],
};

// Option lists mirror the zod enums in the config schemas (tests/settings/fields.test.ts compares them);
// importing the schemas here would pull zod's cron parser into the browser bundle.
/** Time ranges of the AI usage page (mirrors the zod enum in the ui schema; the fields test compares them). */
export const AI_USAGE_RANGES = ["today", "7d", "30d", "month"] as const;
export const REMOTE_SCOPES = ["none", "home_country", "worldwide"] as const;
export const LINKEDIN_CASCADE_OPTIONS = ["linkedin-brightdata", "linkedin-apify", "linkedin-monid", "linkedin-session", "linkedin-guest"] as const;

const bool = (path: string, label: FieldLabelId, extra: Partial<FieldDef> = {}): FieldDef => ({ path, kind: "bool", label, ...extra });
const int = (path: string, label: FieldLabelId, extra: Partial<FieldDef> = {}): FieldDef => ({ path, kind: "int", label, ...extra });
const num = (path: string, label: FieldLabelId, extra: Partial<FieldDef> = {}): FieldDef => ({ path, kind: "number", label, ...extra });
const text = (path: string, label: FieldLabelId, extra: Partial<FieldDef> = {}): FieldDef => ({ path, kind: "text", label, ...extra });
/** A scoring criterion is a whole sentence that may contain commas: only Enter (or leaving the box) ends it. */
const NO_COMMA: Partial<FieldDef> = { commitOnComma: false };
const tags = (path: string, label: FieldLabelId, extra: Partial<FieldDef> = {}): FieldDef => ({ path, kind: "tags", label, ...extra });

// ---------------------------------------------------------------- schedule

const CYCLES = ["weekday_morning", "weekday_evening", "weekend"] as const;

const scheduleSections: SectionDef[] = [
  { id: "general", title: { section: "schedule_general" }, fields: [text("timezone", "timezone", { mono: true })] },
  ...CYCLES.map(
    (cycle): SectionDef => ({
      id: cycle,
      title: { section: `cycle_${cycle}` },
      fields: [text(`cycles.${cycle}.cron`, "cron", { mono: true, cron: true }), bool(`cycles.${cycle}.enabled`, "cycle_enabled")],
    }),
  ),
  {
    id: "behaviour",
    title: { section: "schedule_behaviour" },
    fields: [bool("catch_up", "catch_up"), bool("skip_if_running", "skip_if_running"), int("control_poll_seconds", "control_poll_seconds")],
  },
  {
    id: "backup",
    title: { section: "schedule_backup" },
    fields: [
      bool("backup.enabled", "backup_enabled"),
      text("backup.cron", "cron", { mono: true, cron: true }),
      int("backup.keep_daily", "backup_keep_daily"),
      int("backup.keep_weekly", "backup_keep_weekly"),
      int("backup.timeout_minutes", "backup_timeout"),
      int("backup.max_age_hours", "backup_max_age"),
      bool("backup.config_archive", "backup_config_archive"),
      bool("backup.pre_migrate", "backup_pre_migrate"),
      int("backup.keep_system", "backup_keep_system"),
    ],
  },
  {
    id: "schedule_linkedin_rec",
    title: { section: "schedule_linkedin_rec" },
    fields: [bool("linkedin_recommended.enabled", "linkedin_rec_enabled"), text("linkedin_recommended.cron", "cron", { mono: true, cron: true })],
  },
  {
    id: "schedule_suggest",
    title: { section: "schedule_suggest" },
    fields: [
      bool("suggest.enabled", "suggest_enabled"),
      text("suggest.cron", "cron", { mono: true, cron: true }),
      bool("suggest.notify", "suggest_notify"),
      int("suggest.lookback_weeks", "suggest_lookback_weeks"),
      int("suggest.max_suggestions", "suggest_max"),
      num("suggest.min_confidence", "suggest_min_confidence"),
    ],
  },
  {
    id: "schedule_manual",
    title: { section: "schedule_manual" },
    fields: [int("manual_triggers.min_interval_seconds", "manual_min_interval")],
  },
];

// ---------------------------------------------------------------- search

const searchSections: SectionDef[] = [
  { id: "keywords", title: { section: "search_keywords" }, fields: [{ path: "keyword_groups", kind: "keywordGroups", label: "keyword_groups" }] },
  {
    id: "where",
    title: { section: "search_where" },
    fields: [
      tags("locations", "locations"),
      { path: "remote_scope", kind: "remoteScope", label: "remote_scope" },
    ],
  },
  {
    id: "limits",
    title: { section: "search_limits" },
    fields: [
      int("window_hours.morning", "window_morning"),
      int("window_hours.evening", "window_evening"),
      int("window_hours.weekend", "window_weekend"),
      int("max_per_group_per_location", "max_per_group_per_location"),
    ],
  },
];

// ---------------------------------------------------------------- channels

/** The four keys every channel block has. */
function baseFields(prefix: string, consent = false): FieldDef[] {
  return [
    // a scraping / account channel carries its terms-of-service hint next to the switch (a hint only: hand edits are not blocked)
    bool(`${prefix}.enabled`, consent ? "enabled_consent" : "enabled"),
    num(`${prefix}.monthly_budget_usd`, "monthly_budget_usd"),
    int(`${prefix}.throttle.min_delay_ms`, "throttle_min"),
    int(`${prefix}.throttle.max_delay_ms`, "throttle_max"),
    int(`${prefix}.max_results`, "max_results"),
  ];
}

function channelSection(id: string, prefix: string, extra: FieldDef[] = []): SectionDef {
  return { id, title: { text: id }, collapsible: true, enabledPath: `${prefix}.enabled`, fields: [...baseFields(prefix, consentKind(id) !== null), ...extra] };
}

const atsPrefilter = (prefix: string): FieldDef[] => [
  bool(`${prefix}.title_prefilter.enabled`, "prefilter_enabled"),
  tags(`${prefix}.title_prefilter.include_terms`, "prefilter_include"),
  tags(`${prefix}.title_prefilter.exclude_terms`, "prefilter_exclude"),
];

/** Settings of the two job-board channels, after the shared channel fields. */
const jobBoardFields = (prefix: string): FieldDef[] => [
  text(`${prefix}.base_url`, "base_url", { mono: true }),
  text(`${prefix}.user_agent`, "user_agent", { mono: true }),
  int(`${prefix}.radius_km`, "radius_km"),
  int(`${prefix}.max_pages`, "max_pages"),
  bool(`${prefix}.fetch_details`, "fetch_details"),
  int(`${prefix}.max_details_per_query`, "max_details"),
  bool(`${prefix}.reuse_known_details`, "reuse_known_details"),
  ...atsPrefilter(prefix),
];

const REMOTE_LOCATION_KEYS = ["home_country", "region", "worldwide"] as const;

const channelsSections: SectionDef[] = [
  {
    id: "budget",
    title: { section: "channels_budget" },
    fields: [
      num("paid_total_monthly_budget_usd", "paid_total"),
      int("circuit_breaker.failures", "breaker_failures"),
      num("circuit_breaker.cooldown_hours", "breaker_cooldown"),
      int("collect.concurrency", "collect_concurrency"),
      bool("collect.query_rotation", "collect_query_rotation", { optional: true }),
      int("collect.max_catch_up_hours", "collect_max_catch_up_hours", { optional: true }),
    ],
  },
  {
    id: "http",
    title: { section: "channels_http" },
   
    fields: [
      int("http.timeout_ms", "http_timeout"),
      int("http.max_retries", "http_retries"),
      int("http.backoff_base_ms", "http_backoff_base"),
      int("http.backoff_max_ms", "http_backoff_max"),
    ],
  },
  {
    id: "cascade",
    title: { section: "channels_cascade" },
   
    fields: [{ path: "linkedin.cascade", kind: "ordered", label: "cascade", options: LINKEDIN_CASCADE_OPTIONS }],
  },
  channelSection("linkedin-brightdata", "linkedin.brightdata", [
    int("linkedin.brightdata.free_records_per_month", "free_records"),
    text("linkedin.brightdata.dataset_id", "dataset_id", { mono: true }),
    num("linkedin.brightdata.cost_per_1k_usd", "cost_per_1k"),
    int("linkedin.brightdata.poll_interval_ms", "poll_interval"),
    int("linkedin.brightdata.timeout_ms", "snapshot_timeout"),
    text("linkedin.brightdata.country", "country", { mono: true }),
    ...REMOTE_LOCATION_KEYS.map((key) => text(`linkedin.brightdata.remote_locations.${key}`, `remote_${key}`)),
  ]),
  channelSection("linkedin-apify", "linkedin.apify", [
    text("linkedin.apify.actor_id", "actor_id", { mono: true }),
    text("linkedin.apify.api_base_url", "api_base_url", { mono: true }),
    num("linkedin.apify.price_per_1k_usd", "apify_price_per_1k"),
    num("linkedin.apify.run_start_usd", "apify_run_start"),
    int("linkedin.apify.memory_mb", "apify_memory"),
    int("linkedin.apify.timeout_secs", "apify_timeout"),
    text("linkedin.apify.country_name", "apify_country_name"),
    ...REMOTE_LOCATION_KEYS.map((key) => text(`linkedin.apify.remote_locations.${key}`, `remote_${key}`)),
  ]),
  channelSection("linkedin-monid", "linkedin.monid", [
    text("linkedin.monid.provider", "monid_provider", { mono: true }),
    text("linkedin.monid.endpoint", "monid_endpoint", { mono: true }),
    text("linkedin.monid.api_base_url", "api_base_url", { mono: true }),
    num("linkedin.monid.price_per_1k_usd", "monid_price_per_1k"),
    num("linkedin.monid.flat_fee_usd", "monid_flat_fee"),
    int("linkedin.monid.poll_interval_ms", "poll_interval"),
    int("linkedin.monid.timeout_ms", "monid_timeout"),
    int("linkedin.monid.stop_grace_ms", "monid_stop_grace"),
    text("linkedin.monid.country_name", "apify_country_name"),
    ...REMOTE_LOCATION_KEYS.map((key) => text(`linkedin.monid.remote_locations.${key}`, `remote_${key}`, { optional: true })),
  ]),
  channelSection("linkedin-session", "linkedin.session", [
    bool("linkedin.session.recommended_daily", "recommended_daily"),
    int("linkedin.session.daily_request_limit", "daily_request_limit"),
    int("linkedin.session.max_pages", "max_pages"),
    bool("linkedin.session.fetch_details", "fetch_details"),
  ]),
  channelSection("linkedin-guest", "linkedin.guest"),
  channelSection("arbeitsagentur", "sources.arbeitsagentur", [
    text("sources.arbeitsagentur.base_url", "base_url", { mono: true }),
    text("sources.arbeitsagentur.api_key", "api_key", { mono: true }),
    int("sources.arbeitsagentur.radius_km", "radius_km"),
    int("sources.arbeitsagentur.page_size", "page_size"),
    bool("sources.arbeitsagentur.fetch_details", "fetch_details"),
    int("sources.arbeitsagentur.max_details_per_query", "max_details"),
    bool("sources.arbeitsagentur.reuse_known_details", "reuse_known_details"),
    bool("sources.arbeitsagentur.remote_requires_home_office", "remote_home_office"),
    int("sources.arbeitsagentur.remote_max_pages", "remote_max_pages"),
  ]),
  channelSection("indeed", "sources.indeed"),
  channelSection("stepstone", "sources.stepstone", jobBoardFields("sources.stepstone")),
  channelSection("xing", "sources.xing", [...jobBoardFields("sources.xing"), text("sources.xing.remote_option_id", "remote_option_id", { mono: true })]),
  channelSection("arbeitnow", "sources.arbeitnow", [
    text("sources.arbeitnow.base_url", "base_url", { mono: true }),
    text("sources.arbeitnow.user_agent", "user_agent", { mono: true }),
    int("sources.arbeitnow.max_pages", "arbeitnow_max_pages"),
    ...atsPrefilter("sources.arbeitnow"),
  ]),
  channelSection("jsearch", "sources.jsearch", [
    text("sources.jsearch.api_base_url", "api_base_url", { mono: true }),
    text("sources.jsearch.country", "jsearch_country", { mono: true }),
    text("sources.jsearch.language", "jsearch_language", { mono: true }),
    int("sources.jsearch.pages_per_query", "jsearch_pages"),
    int("sources.jsearch.keywords_per_query", "jsearch_keywords"),
    int("sources.jsearch.monthly_request_limit", "jsearch_request_limit"),
    num("sources.jsearch.overage_cost_per_request_usd", "jsearch_overage_cost"),
    bool("sources.jsearch.pace_requests", "jsearch_pace"),
    bool("sources.jsearch.fetch_details", "jsearch_fetch_details"),
    int("sources.jsearch.max_details_per_query", "jsearch_max_details"),
    tags("sources.jsearch.apply_publisher_preference", "jsearch_apply_publishers"),
    int("sources.jsearch.rate_limit_retries", "jsearch_rate_retries"),
  ]),
  channelSection("greenhouse", "sources.greenhouse", [text("sources.greenhouse.api_base_url", "api_base_url", { mono: true }), ...atsPrefilter("sources.greenhouse")]),
  channelSection("lever", "sources.lever", [
    text("sources.lever.api_base_url", "api_base_url", { mono: true }),
    text("sources.lever.eu_api_base_url", "eu_api_base_url", { mono: true }),
    ...atsPrefilter("sources.lever"),
  ]),
  channelSection("ashby", "sources.ashby", [
    text("sources.ashby.api_base_url", "api_base_url", { mono: true }),
    bool("sources.ashby.include_compensation", "include_compensation"),
    ...atsPrefilter("sources.ashby"),
  ]),
  channelSection("personio", "sources.personio", [
    text("sources.personio.api_base_url", "api_base_url", { mono: true }),
    { path: "sources.personio.language", kind: "select", label: "feed_language", options: ["en", "de"] },
    ...atsPrefilter("sources.personio"),
  ]),
  channelSection("smartrecruiters", "sources.smartrecruiters", [
    text("sources.smartrecruiters.api_base_url", "api_base_url", { mono: true }),
    text("sources.smartrecruiters.country", "country_lower", { mono: true }),
    int("sources.smartrecruiters.page_size", "page_size"),
    bool("sources.smartrecruiters.fetch_details", "fetch_details"),
    ...atsPrefilter("sources.smartrecruiters"),
  ]),
  channelSection("tavily", "sources.tavily", [
    text("sources.tavily.api_base_url", "api_base_url", { mono: true }),
    { path: "sources.tavily.search_depth", kind: "select", label: "tavily_search_depth", options: ["basic", "advanced", "fast", "ultra-fast"] },
    int("sources.tavily.keywords_per_query", "tavily_keywords"),
    int("sources.tavily.interval_hours", "discovery_interval"),
    int("sources.tavily.max_queries_per_run", "max_queries"),
    int("sources.tavily.monthly_credit_limit", "tavily_credit_limit"),
    num("sources.tavily.credit_cost_usd", "tavily_credit_cost"),
  ]),
  channelSection("brave", "sources.brave", [
    text("sources.brave.api_base_url", "api_base_url", { mono: true }),
    text("sources.brave.country", "country", { mono: true }),
    { path: "sources.brave.safesearch", kind: "select", label: "safesearch", options: ["off", "moderate", "strict"] },
    int("sources.brave.interval_hours", "discovery_interval"),
    int("sources.brave.max_queries_per_run", "max_queries"),
  ]),
  channelSection("gmail-alerts", "sources.gmail", [
    text("sources.gmail.host", "gmail_host", { mono: true }),
    int("sources.gmail.port", "gmail_port"),
    bool("sources.gmail.secure", "gmail_secure"),
    text("sources.gmail.label", "gmail_label", { mono: true }),
    int("sources.gmail.max_messages_per_cycle", "gmail_max_messages"),
    int("sources.gmail.lookback_days", "gmail_lookback_days"),
    int("sources.gmail.timeout_ms", "gmail_timeout"),
    ...(["linkedin", "stepstone", "indeed", "xing"] as const).map((platform) => tags(`sources.gmail.senders.${platform}`, `gmail_senders_${platform}`)),
  ]),
  channelSection("jobspy-google", "sources.jobspy_google"),
  {
    id: "jobspy",
    title: { section: "channels_jobspy" },
   
    collapsible: true,
    fields: [
      text("jobspy.url", "jobspy_url", { mono: true }),
      int("jobspy.timeout_ms", "jobspy_timeout"),
      text("jobspy.country_indeed", "country_indeed", { mono: true }),
      bool("jobspy.linkedin_fetch_description", "linkedin_fetch_description"),
      ...REMOTE_LOCATION_KEYS.map((key) => text(`jobspy.remote_location.${key}`, `remote_${key}`)),
    ],
  },
];

// ---------------------------------------------------------------- ai

// The choices come from `config/ai-options.ts`, the module the ai.yaml schema builds its enums from.
// The models themselves come from the catalog `models.yaml`.
const model = (provider: AiProviderIdChoice, prefix: string, key: "model" | "strong_model", label: FieldLabelId, extra: Partial<FieldDef> = {}): FieldDef => ({
  path: `${prefix}.${key}`,
  kind: "model",
  label,
  provider,
  mono: true,
  ...extra,
});

/** The six weights of the pre-score, the seniority levels and the location cases `scoring.priority` has (tests compare them with the schema). */
export const PRIORITY_WEIGHTS = ["title", "signals", "location", "seniority", "recency", "language_gap"] as const;
export const PRIORITY_SENIORITY = ["intern", "junior", "mid", "senior", "staff", "principal", "lead", "manager", "unknown"] as const;
export const PRIORITY_LOCATION = ["exact", "nearby", "remote", "country_level", "other", "unclear"] as const;
/** Prefix of the pre-score sections of the AI tab (`SectionDef.id`). */
export const PRIORITY_SECTION_PREFIX = "scoring_priority";

const aiSections: SectionDef[] = [
  {
    id: "order",
    block: "routing",
    title: { section: "ai_order" },
   
    fields: [
      { path: "order", kind: "ordered", label: "ai_order", options: AI_PROVIDER_KINDS, aiProviders: true },
      { path: "api_order", kind: "ordered", label: "api_order", options: AI_API_PROVIDERS, aiProviders: true },
    ],
  },
  {
    id: "tasks",
    block: "routing",
    title: { section: "ai_tasks" },
   
    fields: AI_TASK_NAMES.map((task): FieldDef => ({ path: `tasks.${task}`, kind: "route", label: `task_${task}`, options: AI_TASK_PROVIDERS, optional: true, aiProviders: true })),
  },
  {
    id: "claude_cli",
    block: "providers",
    title: { text: "claude-cli" },
    collapsible: true,
    catalogProvider: "claude-cli",
    modelPath: "providers.claude_cli.model",
    fields: [
      bool("providers.claude_cli.enabled", "provider_enabled"),
      model("claude-cli", "providers.claude_cli", "model", "model"),
      model("claude-cli", "providers.claude_cli", "strong_model", "strong_model"),
      int("providers.claude_cli.daily_request_cap", "daily_request_cap"),
      text("providers.claude_cli.command", "cli_command", { mono: true, advanced: true }),
      int("providers.claude_cli.timeout_seconds", "timeout_seconds", { advanced: true }),
    ],
  },
  {
    id: "codex_cli",
    block: "providers",
    title: { text: "codex-cli" },
    collapsible: true,
    catalogProvider: "codex-cli",
    modelPath: "providers.codex_cli.model",
    fields: [
      bool("providers.codex_cli.enabled", "provider_enabled"),
      model("codex-cli", "providers.codex_cli", "model", "model_optional", { optional: true, emptyOption: "cliDefault" }),
      { path: "providers.codex_cli.reasoning_effort", kind: "select", label: "reasoning_effort", options: CODEX_REASONING_EFFORTS, mono: true, effortModelPath: "providers.codex_cli.model" },
      ...AI_TASK_NAMES.map(
        (task): FieldDef => ({
          path: `providers.codex_cli.reasoning_effort_by_task.${task}`,
          kind: "select",
          label: `reasoning_effort_${task}`,
          options: CODEX_REASONING_EFFORTS,
          optional: true,
          emptyOption: "inheritEffort",
          mono: true,
          advanced: true,
          effortModelPath: "providers.codex_cli.model",
        }),
      ),
      int("providers.codex_cli.daily_request_cap", "daily_request_cap"),
      text("providers.codex_cli.command", "cli_command", { mono: true, advanced: true }),
      int("providers.codex_cli.timeout_seconds", "timeout_seconds", { advanced: true }),
    ],
  },
  {
    id: "anthropic",
    block: "providers",
    title: { text: "anthropic" },
    collapsible: true,
    catalogProvider: "anthropic",
    modelPath: "providers.anthropic.model",
    fields: [
      bool("providers.anthropic.enabled", "provider_enabled"),
      model("anthropic", "providers.anthropic", "model", "model"),
      model("anthropic", "providers.anthropic", "strong_model", "strong_model"),
      int("providers.anthropic.daily_request_cap", "daily_request_cap"),
    ],
  },
  {
    id: "deepseek",
    block: "providers",
    title: { text: "deepseek" },
    collapsible: true,
    catalogProvider: "deepseek",
    modelPath: "providers.deepseek.model",
    fields: [
      bool("providers.deepseek.enabled", "provider_enabled"),
      model("deepseek", "providers.deepseek", "model", "model"),
      int("providers.deepseek.daily_request_cap", "daily_request_cap"),
      text("providers.deepseek.base_url", "base_url", { mono: true, advanced: true }),
      bool("providers.deepseek.json_mode_only", "json_mode_only", { advanced: true }),
    ],
  },
  {
    id: "mimo",
    block: "providers",
    title: { text: "mimo" },
    collapsible: true,
    catalogProvider: "mimo",
    modelPath: "providers.mimo.model",
    fields: [
      bool("providers.mimo.enabled", "provider_enabled"),
      model("mimo", "providers.mimo", "model", "model"),
      int("providers.mimo.daily_request_cap", "daily_request_cap"),
      text("providers.mimo.base_url", "base_url", { mono: true, advanced: true }),
      bool("providers.mimo.json_mode_only", "json_mode_only", { advanced: true }),
    ],
  },
  {
    id: "limits_cycle",
    block: "limits",
    title: { section: "ai_limits_cycle" },
    fields: [int("per_cycle_limit", "per_cycle_limit"), int("cycle_budget_minutes", "cycle_budget_minutes"), int("idle_cycle_budget_minutes", "idle_cycle_budget_minutes"), num("translate_auto_min_score", "translate_min_score")],
  },
  {
    id: "limits_cooldown",
    block: "limits",
    title: { section: "ai_limits_cooldown" },
    fields: [int("cooldown.default_minutes", "cooldown_default_minutes"), int("cooldown.max_minutes", "cooldown_max_minutes")],
  },
  // Job Radar's own cap on the subscription CLIs (counts only its own calls; not the account's remaining quota)
  {
    id: "limits_quota",
    block: "limits",
    title: { section: "ai_limits_quota" },
    fields: [
      bool("quota_guard.enabled", "quota_enabled"),
      bool("quota_guard.fallthrough_to_api", "quota_fallthrough_to_api"),
      bool("quota_guard.notify_recovery", "quota_notify_recovery"),
      ...(["codex_cli", "claude_cli"] as const).flatMap((id) => [
        int(`quota_guard.providers.${id}.cycle_request_cap`, `quota_cycle_cap_${id}`),
        int(`quota_guard.providers.${id}.hard_requests`, `quota_hard_${id}`),
        int(`quota_guard.providers.${id}.window_hours`, `quota_window_${id}`, { advanced: true }),
      ]),
      num("quota_guard.resume_ratio", "quota_resume_ratio", { advanced: true }),
      int("quota_guard.alert_dedupe_hours", "quota_alert_dedupe_hours", { advanced: true }),
    ],
  },
  {
    id: "limits_api",
    block: "limits",
    title: { section: "ai_limits_api" },
    fields: [num("monthly_api_budget_usd", "monthly_api_budget"), int("api_timeout_seconds", "api_timeout"), int("max_output_tokens", "max_output_tokens")],
  },
  {
    id: "scoring",
    block: "scoring",
    title: { section: "ai_scoring_jd" },
    fields: [int("scoring.jd_max_chars", "scoring_jd_max_chars"), num("scoring.jd_head_share", "scoring_jd_head_share"), int("scoring.concurrency", "scoring_concurrency"), int("scoring.backlog_per_run", "scoring_backlog_per_run")],
  },
  // The user's own scoring criteria (sentences in any language); changing them re-scores, the tab says how many
  {
    id: "scoring_criteria",
    block: "scoring",
    title: { section: "ai_scoring_criteria" },
    fields: [tags("scoring.criteria.priorities", "scoring_criteria_priorities", NO_COMMA), tags("scoring.criteria.dealbreakers", "scoring_criteria_dealbreakers", NO_COMMA), tags("scoring.criteria.nice_to_have", "scoring_criteria_nice", NO_COMMA)],
  },
  // Reason sources: off by default (output tokens); neither key re-scores
  {
    id: "scoring_evidence",
    block: "scoring",
    title: { section: "ai_scoring_evidence" },
    fields: [bool("scoring.evidence.enabled", "scoring_evidence_enabled"), int("scoring.evidence.quote_max_chars", "scoring_evidence_quote_max"), int("scoring.evidence.quote_min_chars", "scoring_evidence_quote_min")],
  },
  {
    id: "scoring_german",
    block: "scoring",
    title: { section: "ai_scoring_german" },
    fields: [
      // a level without a number costs nothing: leaving the box empty removes the key
      ...(["A1", "A2", "B1", "B2", "C1", "C2"] as const).map((level) => int(`scoring.language_penalty.${level}`, `german_penalty_${level}`, { optional: true })),
    ],
  },
  // The AI-free pre-score that decides which waiting jobs are scored first (`scoring.priority`). The AI tab shows these four
  // sections folded under one "pre-sort" heading; the weights' sum is shown there for reference (it does not have to be 100).
  {
    id: "scoring_priority_weights",
    block: "scoring",
    title: { section: "ai_priority_weights" },
    fields: PRIORITY_WEIGHTS.map((key) => num(`scoring.priority.weights.${key}`, `priority_weight_${key}`)),
  },
  {
    id: "scoring_priority_title",
    block: "scoring",
    title: { section: "ai_priority_title" },
    fields: [
      num("scoring.priority.keyword_group_factor", "priority_keyword_group_factor"),
      num("scoring.priority.all_words_match", "priority_all_words_match"),
      num("scoring.priority.partial_match", "priority_partial_match"),
      tags("scoring.priority.generic_title_words", "priority_generic_words"),
    ],
  },
  {
    id: "scoring_priority_seniority",
    block: "scoring",
    title: { section: "ai_priority_seniority" },
    fields: [
      bool("scoring.priority.seniority_from_preferences", "priority_seniority_follow"),
      { path: "scoring.priority.seniority_distance_fit", kind: "numberList", label: "priority_seniority_distance", dedupe: "none" },
      ...PRIORITY_SENIORITY.map((key) => num(`scoring.priority.seniority_fit.${key}`, `priority_seniority_${key}`)),
    ],
  },
  {
    id: "scoring_priority_location",
    block: "scoring",
    title: { section: "ai_priority_location" },
    fields: [
      ...PRIORITY_LOCATION.map((key) => num(`scoring.priority.location_fit.${key}`, `priority_location_${key}`)),
      num("scoring.priority.unclear_location_factor", "priority_unclear_factor"),
      int("scoring.priority.recency_days", "priority_recency_days"),
    ],
  },
];

// ---------------------------------------------------------------- breakdown

const breakdownSections: SectionDef[] = [
  {
    id: "breakdown_general",
    title: { section: "breakdown_general" },
    fields: [bool("enabled", "breakdown_enabled"), { path: "mode", kind: "select", label: "breakdown_mode", options: BREAKDOWN_MODES, optionGroup: "breakdownMode" }],
  },
  {
    id: "breakdown_auto",
    title: { section: "breakdown_auto" },
    fields: [num("auto.min_rank", "breakdown_min_rank"), int("auto.per_cycle_limit", "breakdown_per_cycle_limit")],
  },
  {
    id: "breakdown_request",
    title: { section: "breakdown_request" },
    fields: [int("jd_max_chars", "breakdown_jd_max_chars"), num("jd_head_share", "breakdown_jd_head_share"), int("timeout_seconds", "breakdown_timeout")],
  },
];

// ---------------------------------------------------------------- salary

const salarySections: SectionDef[] = [
  {
    id: "salary_lookup",
    title: { section: "salary_lookup" },
    fields: [bool("lookup.enabled", "salary_lookup_enabled"), int("lookup.ttl_days", "salary_ttl_days"), int("lookup.max_per_day", "salary_max_per_day"), int("lookup.timeout_seconds", "salary_timeout")],
  },
  {
    id: "salary_benchmark",
    title: { section: "salary_benchmark" },
    fields: [bool("benchmark.enabled", "salary_benchmark_enabled"), int("benchmark.window_days", "salary_window_days"), int("benchmark.min_sample", "salary_min_sample")],
  },
];

// ---------------------------------------------------------------- notify
// pipeline.yaml (hard filter, dedupe, salary rules, ...) is not a settings tab: it is edited in the YAML.

const notifySections: SectionDef[] = [
  {
    id: "push",
    title: { section: "notify_push" },
    fields: [
      bool("telegram.enabled", "telegram_enabled"),
      num("push_min_score", "push_min_score"),
      num("push_min_score_high_value", "push_min_score_high_value"),
      int("max_per_cycle", "max_per_cycle"),
      int("candidate_window_hours", "candidate_window"),
      text("public_base_url", "public_base_url", { mono: true, nullable: true }),
    ],
  },
  {
    id: "quiet",
    title: { section: "notify_quiet" },
    fields: [
      bool("quiet_hours.enabled", "quiet_enabled"),
      text("quiet_hours.start", "quiet_start", { mono: true }),
      text("quiet_hours.end", "quiet_end", { mono: true }),
      bool("quiet_hours.alerts_exempt", "alerts_exempt"),
    ],
  },
  {
    id: "alerts",
    title: { section: "notify_alerts" },
    fields: [int("alerts.dedupe_hours", "alerts_dedupe"), { path: "alerts.budget_thresholds", kind: "numberList", label: "budget_thresholds" }],
  },
  {
    id: "reminders",
    title: { section: "notify_reminders" },
    fields: [
      bool("reminders.enabled", "reminders_enabled"),
      text("reminders.send_at", "reminders_send_at", { mono: true }),
      int("reminders.max_items", "reminders_max_items"),
    ],
  },
  {
    id: "telegram",
    title: { section: "notify_telegram" },
    collapsible: true,
    fields: [
      text("telegram.api_base_url", "telegram_api_base_url", { mono: true }),
      int("telegram.poll_timeout_seconds", "telegram_poll_timeout"),
      int("telegram.request_timeout_seconds", "telegram_request_timeout"),
      int("telegram.poll_backoff_seconds", "telegram_backoff"),
      int("telegram.poll_backoff_max_seconds", "telegram_backoff_max"),
      int("telegram.message_gap_ms", "telegram_message_gap"),
      int("telegram.max_retries", "telegram_retries"),
    ],
  },
];

// ---------------------------------------------------------------- ui

const uiSections: SectionDef[] = [
  {
    id: "salary_axis",
    title: { section: "ui_salary_axis" },
    fields: [int("salary_axis.min_k", "ui_salary_min"), int("salary_axis.max_k", "ui_salary_max"), int("salary_axis.tick_step_k", "ui_salary_step"), int("salary_stats.min_sample", "ui_salary_sample")],
  },
  {
    id: "freshness",
    title: { section: "ui_freshness" },
    fields: [int("freshness.decay_hours", "ui_fresh_decay"), int("freshness.warn_hours", "ui_fresh_warn")],
  },
  {
    id: "lists",
    title: { section: "ui_lists" },
    fields: [int("trend_cycles", "ui_trend_cycles"), int("health_cycles", "ui_health_cycles"), int("ticker_max_items", "ui_ticker_items")],
  },
  {
    id: "ui_ai_usage",
    title: { section: "ui_ai_usage" },
    fields: [
      { path: "ai_usage.default_range", kind: "select", label: "ui_ai_range", options: AI_USAGE_RANGES, optionGroup: "aiUsageRange" },
      int("ai_usage.custom_max_days", "ui_ai_max_days"),
      int("ai_usage.log_page_size", "ui_ai_page_size"),
      int("ai_usage.csv_max_rows", "ui_ai_csv_rows"),
    ],
  },
];

// ---------------------------------------------------------------- language

/** An interface-language dropdown; `follow`: the empty choice "same as the interface default" stands for null. */
const localeSelect = (path: string, label: FieldLabelId, follow = false): FieldDef => ({
  path,
  kind: "select",
  label,
  options: LOCALES,
  localeOptions: true,
  ...(follow ? { optional: true, nullable: true, emptyOption: "followUi" as const } : {}),
});

const languageSections: SectionDef[] = [
  {
    id: "language_ui",
    title: { section: "language_ui" },
    fields: [localeSelect("ui.default_locale", "language_default_locale")],
  },
  {
    id: "language_ai",
    title: { section: "language_ai" },
    fields: [text("ai.output", "language_ai_output", { mono: true, languageCode: true }), tags("ai.summary_also", "language_summary_also", { languageCode: true }), text("translation.target", "language_translation_target", { mono: true, languageCode: true })],
  },
  {
    id: "language_channels",
    title: { section: "language_channels" },
    fields: [localeSelect("notify.locale", "language_notify_locale", true), localeSelect("cli.locale", "language_cli_locale", true)],
  },
];

// ---------------------------------------------------------------- insights (form since the config editor)

const insightsSections: SectionDef[] = [
  {
    id: "insights_page",
    title: { section: "insights_page" },
    fields: [
      { path: "ranges_days", kind: "numberList", label: "insights_ranges" },
      int("default_range_days", "insights_default_range"),
      tags("cities", "insights_cities"),
      int("top_filter_reasons", "insights_top_reasons"),
    ],
  },
  {
    id: "insights_histograms",
    title: { section: "insights_histograms" },
    fields: [
      int("score_bucket_width", "insights_score_width"),
      int("score_bucket_cap", "insights_score_cap"),
      int("salary_bucket", "insights_salary_width"),
      int("salary_bucket_cap", "insights_salary_cap"),
    ],
  },
];

// ---------------------------------------------------------------- resume (form since the config editor)

/** The paths are absolute and may be empty (the feature that needs one is then off): `text` + `nullable`. */
const resumePath = (path: string, label: FieldLabelId): FieldDef => text(path, label, { mono: true, nullable: true });

const resumeSections: SectionDef[] = [
  {
    id: "resume_paths",
    title: { section: "resume_paths" },
    fields: [
      resumePath("resume_kit_path", "resume_kit_path"),
      resumePath("master_resume_path", "resume_master_path"),
      resumePath("pdf_dir", "resume_pdf_dir"),
      text("jd_export_dir", "resume_jd_dir", { mono: true }),
      resumePath("jd_export_host_dir", "resume_jd_host_dir"),
      text("claude_command", "resume_claude_command", { mono: true }),
      text("claude_args", "resume_claude_args", { mono: true }),
    ],
  },
  {
    id: "resume_export",
    title: { section: "resume_export" },
    fields: [int("filename_part_max_chars", "resume_filename_chars"), int("signal_quote_max_chars", "resume_quote_chars"), int("pdf_list_limit", "resume_pdf_limit")],
  },
];

/** Marks the fields of protected keys as `locked` (the forms show them read-only). */
function withLocks(form: SettingsForm, sections: SectionDef[]): SectionDef[] {
  return sections.map((section) => ({ ...section, fields: section.fields.map((field) => (isProtectedPath(form, field.path) ? { ...field, locked: true } : field)) }));
}

export const SETTINGS_SECTIONS: Record<SettingsForm, SectionDef[]> = {
  schedule: withLocks("schedule", scheduleSections),
  search: withLocks("search", searchSections),
  channels: withLocks("channels", channelsSections),
  ai: withLocks("ai", aiSections),
  breakdown: withLocks("breakdown", breakdownSections),
  salary: withLocks("salary", salarySections),
  notify: withLocks("notify", notifySections),
  language: withLocks("language", languageSections),
  ui: withLocks("ui", uiSections),
  insights: withLocks("insights", insightsSections),
  resume: withLocks("resume", resumeSections),
};

export function fieldsOf(tab: SettingsForm): FieldDef[] {
  return SETTINGS_SECTIONS[tab].flatMap((section) => section.fields);
}
