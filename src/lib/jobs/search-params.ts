import { createLoader, createMultiParser, createParser, createSerializer, parseAsBoolean, parseAsInteger, parseAsString, parseAsStringLiteral, type inferParserType } from "nuqs/server";

import { FAVORITE_SORTS, JOB_SCOPES, JOB_SORTS, MIN_SALARY_MAX, MIN_SCORE_MAX, GHOST_FILTERS, SORT_DIRS, TRAP_FILTERS, VISA_FILTERS } from "./constants";
import { FILTER_KEYS, NUMBER_FILTER_KEYS, type FilterKey, type MultiFilterKey } from "./filter-keys";
import { cleanMultiValues, type MultiValue } from "./filter-values";

/**
 * URL state of /jobs. Shared by the server page (parses `searchParams`) and the filter bar (nuqs
 * hooks), so both agree on what a valid value is. Invalid values fall back to "not set".
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` that is a real calendar date. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

const parseAsDay = createParser<string>({
  parse: (value) => (isCalendarDate(value) ? value : null),
  serialize: (value) => value,
});

/** A whole number within `0..max`; anything else reads as "not set". */
const boundedInt = (max: number) =>
  createParser<number>({
    parse: (value) => {
      if (!/^\d{1,9}$/.test(value)) return null;
      const n = Number(value);
      return n <= max ? n : null;
    },
    serialize: (value) => String(Math.round(value)),
  });

/**
 * A categorical filter with several values (OR), written as repeated keys (`city=Berlin&city=M%C3%BCnchen`), not comma
 * separated: a comma in the URL makes Next's link prefetch of the same page hang and city names contain
 * commas. A single old-style value (`?city=Berlin`) reads as a one-element list. Invalid, empty, duplicate and surplus
 * values are dropped; no value = not set (`[]`, never in the URL).
 */
function parseAsMultiValues<K extends MultiFilterKey>(key: K) {
  return createMultiParser<MultiValue<K>[]>({
    parse: (query) => {
      const values = cleanMultiValues(key, query);
      return values.length > 0 ? values : null;
    },
    serialize: (values) => [...values],
    eq: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]),
  }).withDefault([]);
}

export const jobsSearchParsers = {
  /** No default: absent scope preserves legacy status links; explicit scope intersects status. Not a filter or saved-view key. */
  scope: parseAsStringLiteral(JOB_SCOPES),
  q: parseAsString,
  /** Not a filter or view key: clearing filters preserves the chosen search scope. */
  searchIn: parseAsStringLiteral(["all"]),
  /** Source family (`channels.family`). */
  source: parseAsMultiValues("source"),
  city: parseAsMultiValues("city"),
  country: parseAsMultiValues("country"),
  /** Company display names (any of them); see `resolveViewCompanyIds` for what one matches. */
  company: parseAsMultiValues("company"),
  workplace: parseAsMultiValues("workplace"),
  contract: parseAsMultiValues("contract"),
  status: parseAsMultiValues("status"),
  reason: parseAsMultiValues("reason"),
  /** Application statuses (`new` = no application yet). `archived` = ignored. */
  app: parseAsMultiValues("app"),
  /** Rank value at least this (unscored and filtered-out jobs have none and drop out). */
  minScore: boundedInt(MIN_SCORE_MAX),
  /** Stated annual salary (upper bound, EUR) at least this; jobs without a usable salary drop out. */
  minSalary: boundedInt(MIN_SALARY_MAX),
  from: parseAsDay,
  to: parseAsDay,
  salary: parseAsBoolean,
  /** Show the jobs the hard filter removed (they are hidden by default). */
  filtered: parseAsBoolean,
  /** Only the jobs the hard filter removed (what a "filtered out" number on /insights opens). */
  filteredOnly: parseAsBoolean,
  /** Hide jobs that need more of the local language than me.yaml has (was `hideGerman`). */
  hideLang: parseAsBoolean,
  /** The old name of `hideLang` (`LEGACY_HIDE_LANG_KEY`): read as `hideLang` by `withLegacyKeys`, never written. */
  hideGerman: parseAsBoolean,
  /** Quick filter: only jobs with a high-value signal (interests.yaml categories with `high_value`). */
  high: parseAsBoolean,
  /** The old name of `high` (`LEGACY_HIGH_KEY`): read as `high` by `withLegacyKeys`, never written. */
  t12: parseAsBoolean,
  /** Only jobs with an AI trap (`only`) or none of them (`hide`); absent = all. */
  trap: parseAsStringLiteral(TRAP_FILTERS),
  /**
   * The visa check: only jobs whose JD mentions visa support (`offered`), or all but those that refuse (`not_denied`); absent = all.
   * Kept in the URL while the filter is hidden (me.yaml / ui.yaml), but then it filters nothing.
   */
  visa: parseAsStringLiteral(VISA_FILTERS),
  /**
   * The ghost job check: only jobs marked watch / likely (`only`), or all but the likely ones (`hide`); `all` (or absent) = no filter.
   * Kept in the URL while the check is off (ui.yaml), but then it filters nothing.
   */
  ghost: parseAsStringLiteral(GHOST_FILTERS),
  /** Only starred jobs. Not stored in saved views. */
  fav: parseAsBoolean,
  /** Only jobs not looked at yet. Not stored in saved views. */
  unseen: parseAsBoolean,
  relisted: parseAsBoolean,
  /** Preserve explicit rank versus absent/invalid; every reader uses resolveSort with the resolved scope and q. */
  sort: parseAsStringLiteral(JOB_SORTS),
  /** The sort's direction; absent (or invalid) = the sort's default (`DEFAULT_SORT_DIR`). Not a filter: never counted, never in a saved view. */
  dir: parseAsStringLiteral(SORT_DIRS),
  page: parseAsInteger.withDefault(1),
};

export const loadJobsSearchParams = createLoader(jobsSearchParsers);

const serializeJobsParams = createSerializer(jobsSearchParsers);

/**
 * The URL of /jobs for these params, for `<Link href>`. nuqs leaves `,` `/` `:` `=` `é` ... as they are, but Next
 * answers every request with its own spelling of the query (`URLSearchParams`: `ai%2Cml`). When the link's spelling
 * differs, the prefetch of the link never settles (`q=ai,ml`, a request that stays pending on touch screens).
 * So the query is rewritten the way `URLSearchParams` writes it, which is what Next compares with.
 */
export function jobsListHref(values: Partial<{ [K in keyof typeof jobsSearchParsers]: JobsSearchParams[K] | null }>): string {
  const url = serializeJobsParams("/jobs", { ...values, ...(values.sort === "relevance" || (values.sort == null && values.q?.trim()) ? { dir: null } : {}) });
  const at = url.indexOf("?");
  if (at < 0) return url;
  const query = new URLSearchParams(url.slice(at + 1)).toString();
  return query ? `${url.slice(0, at)}?${query}` : url.slice(0, at);
}

/** The query string of the list `values` select, without the page (what "mark all seen" re-reads on the server). */
export function jobsSearchQuery(values: Partial<{ [K in keyof typeof jobsSearchParsers]: JobsSearchParams[K] | null }>): string {
  const href = jobsListHref({ ...values, page: null });
  const at = href.indexOf("?");
  return at < 0 ? "" : href.slice(at + 1);
}

export type JobsSearchParams = inferParserType<typeof jobsSearchParsers>;

/**
 * `high` with the old `t12` read as it, `hideLang` with the old `hideGerman` (an explicit new key wins); the old keys become
 * unset, so they are never written back.
 */
export function withLegacyKeys<P extends { high?: boolean | null; t12?: boolean | null; hideLang?: boolean | null; hideGerman?: boolean | null }>(params: P): P {
  return { ...params, high: params.high ?? params.t12 ?? null, t12: null, hideLang: params.hideLang ?? params.hideGerman ?? null, hideGerman: null };
}

type FilterParams = Pick<JobsSearchParams, FilterKey>;

function isSet(key: FilterKey, params: Partial<FilterParams>): boolean {
  const value = params[key];
  if (Array.isArray(value)) return value.length > 0;
  // `ghost=all` says "no filter" out loud: never counted, never a chip
  if (typeof value === "string") return value !== "" && !(key === "ghost" && value === "all");
  return Boolean(value) || ((NUMBER_FILTER_KEYS as readonly string[]).includes(key) && typeof value === "number");
}

/** Filters that are in the URL but do nothing right now (the visa or ghost filter while it is hidden): never counted as set. */
export interface FilterVisibility {
  ignore?: readonly FilterKey[];
}

/** Whether any filter (not sort or page) is set; the "show filtered" switch does not count (it widens the list). */
export function hasActiveFilters(params: Partial<FilterParams>, visibility: FilterVisibility = {}): boolean {
  return FILTER_KEYS.some((key) => key !== "filtered" && !visibility.ignore?.includes(key) && isSet(key, params));
}

/** How many filters are set (search text, sort, page and the "show filtered" switch excluded): the number on the mobile "Filters (n)" button. A multi filter counts once, however many values it has. */
export function countActiveFilters(params: Partial<FilterParams>, visibility: FilterVisibility = {}): number {
  return FILTER_KEYS.filter((key) => key !== "q" && key !== "filtered" && !visibility.ignore?.includes(key) && isSet(key, params)).length;
}

/** URL state of /favorites: how the list is ordered; an invalid value reads as the default. */
export const favoritesSearchParsers = {
  sort: parseAsStringLiteral(FAVORITE_SORTS).withDefault("starred"),
};

export const loadFavoritesSearchParams = createLoader(favoritesSearchParsers);
