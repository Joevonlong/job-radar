/** Sort orders of /jobs (the drop-down orders them itself); relevance is fixed descending. */
export const JOB_SORTS = ["relevance", "rank", "posted", "first_seen", "salary", "last_listed"] as const;
export type JobSort = (typeof JOB_SORTS)[number];

export const JOB_SCOPES = ["current", "archive", "all"] as const;
export type JobScope = (typeof JOB_SCOPES)[number];

export const ARCHIVE_REASONS = ["manual", "gone", "dormant"] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

/** The direction of a /jobs sort (URL `dir`); absent = the sort's own default (`DEFAULT_SORT_DIR`). */
export const SORT_DIRS = ["asc", "desc"] as const;
export type SortDir = (typeof SORT_DIRS)[number];

/** The direction a sort takes when the URL does not say: best, highest-paid and newest first. A UI behaviour, not a threshold. */
export const DEFAULT_SORT_DIR: Readonly<Record<JobSort, SortDir>> = { relevance: "desc", rank: "desc", posted: "desc", first_seen: "desc", salary: "desc", last_listed: "desc" };

/** Sort orders of /favorites: when starred (newest first), or the rank value. */
export const FAVORITE_SORTS = ["starred", "rank"] as const;
export type FavoriteSort = (typeof FAVORITE_SORTS)[number];

export const JOB_WORKPLACES = ["onsite", "hybrid", "remote", "unknown"] as const;
export const JOB_STATUSES = ["active", "possibly_closed", "closed"] as const;

/**
 * Application statuses the /jobs filter offers, in pipeline order (same values as the
 * `application_status` enum; a test keeps them equal). `new` also matches jobs without an application.
 * `archived` is shown as "ignored": the way back to jobs the user has dismissed.
 */
export const APPLICATION_FILTER_STATUSES = ["new", "interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"] as const;
export type ApplicationFilterStatus = (typeof APPLICATION_FILTER_STATUSES)[number];

/** Bounds of the numeric filters (the URL and saved views are validated against them). */
export const MIN_SCORE_MAX = 100;
export const MIN_SALARY_MAX = 1_000_000;

/**
 * Input-validation bounds of the multi-value filters (URL and saved views), like `MIN_SCORE_MAX`: at most this many
 * values per filter and this many characters per value; the rest is ignored.
 */
export const MAX_FILTER_VALUES = 50;
export const MAX_FILTER_VALUE_CHARS = 120;

/** The "AI trap" filter of /jobs and saved views: only jobs with a trap, or none of them (absent = all). */
export const TRAP_FILTERS = ["only", "hide"] as const;
export type TrapFilter = (typeof TRAP_FILTERS)[number];

/**
 * The "Visa" filter of /jobs and saved views: only jobs whose JD mentions visa support, or every job except those whose JD refuses
 * sponsorship or requires a permit (unclear and not yet checked jobs stay in). Absent = all.
 */
export const VISA_FILTERS = ["offered", "not_denied"] as const;
export type VisaFilter = (typeof VISA_FILTERS)[number];

/**
 * The "Ghost jobs" filter of /jobs and saved views: `only` = jobs marked watch or likely, `hide` = all but the likely ones (a dismissed
 * mark counts as none). `all` says "no filter" out loud (the same as no parameter; saved views never store it).
 */
export const GHOST_FILTERS = ["all", "only", "hide"] as const;
export type GhostFilter = (typeof GHOST_FILTERS)[number];
