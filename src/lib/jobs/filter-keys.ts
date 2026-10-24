/**
 * The filters of /jobs and of saved views, listed once by kind. Everything that has to treat "every filter"
 * (active-filter checks, clear, view <-> URL conversion) derives from these tables, so a new filter is one entry here.
 * Pure constants: the client and the server share it.
 */

export const TEXT_FILTER_KEYS = ["q"] as const;
/**
 * Categorical filters: repeated URL keys, OR within a key. `app` was the first. `company`: company display names, each matching the
 * company rows the hard filter's exclusion list would match (`companyFilterKeys`), never a substring.
 */
export const MULTI_FILTER_KEYS = ["source", "city", "company", "workplace", "contract", "status", "app"] as const;
/** The multi filters shown as drop-downs (the application statuses are a pill group). */
export const SELECT_FILTER_KEYS = ["source", "city", "company", "workplace", "contract", "status"] as const;
/** Multi filters that saved views write as a scalar when one value is picked (single-valued before multi-value filters); `company` came later and is always a list. */
export const SCALAR_COMPAT_KEYS = ["source", "city", "workplace", "contract", "status"] as const;
export const NUMBER_FILTER_KEYS = ["minScore", "minSalary"] as const;
export const DATE_FILTER_KEYS = ["from", "to"] as const;
/** `fav` (starred jobs only) is a URL-only filter: saved views never store it (see `NON_VIEW_FILTER_KEYS`). */
/** `high`: only jobs with a high-value signal; old links say `t12` (see `LEGACY_HIGH_KEY`). */
/** `unseen`: only jobs not looked at yet; URL-only like `fav`. */
/** `filteredOnly`: only the jobs the hard filter removed (the "filtered out" links of /insights); URL-only like `fav`. */
export const TOGGLE_FILTER_KEYS = ["salary", "filtered", "hideLang", "high", "fav", "unseen", "filteredOnly"] as const;
/** three-way choices (absent = all): `trap=only|hide`, `visa=offered|not_denied`, `ghost=only|hide` (`ghost=all` = absent). */
export const CHOICE_FILTER_KEYS = ["trap", "visa", "ghost"] as const;
/** Filters that live in the /jobs URL but not in saved views (interests.yaml keeps its shape). */
export const NON_VIEW_FILTER_KEYS = ["fav", "unseen", "filteredOnly"] as const;

/** Every filter key, in the order lists and chips show them. */
export const FILTER_KEYS = ["q", "source", "city", "company", "workplace", "contract", "status", "app", "minScore", "minSalary", "from", "to", "salary", "filtered", "hideLang", "high", "trap", "visa", "ghost", "fav", "unseen", "filteredOnly"] as const;

/**
 * The URL key the "high-value signals only" filter had before the signal categories ("T1/T2 only"). Still read, as `high`, so old links and
 * bookmarks keep working; never written (setting `high` clears it).
 */
export const LEGACY_HIGH_KEY = "t12";

/** The URL key of the local-language filter before the market packs (German was the only local language); read as `hideLang`, never written. */
export const LEGACY_HIDE_LANG_KEY = "hideGerman";

export type TextFilterKey = (typeof TEXT_FILTER_KEYS)[number];
export type MultiFilterKey = (typeof MULTI_FILTER_KEYS)[number];
export type SelectFilterKey = (typeof SELECT_FILTER_KEYS)[number];
export type ScalarCompatKey = (typeof SCALAR_COMPAT_KEYS)[number];
export type NumberFilterKey = (typeof NUMBER_FILTER_KEYS)[number];
export type DateFilterKey = (typeof DATE_FILTER_KEYS)[number];
export type ToggleFilterKey = (typeof TOGGLE_FILTER_KEYS)[number];
export type ChoiceFilterKey = (typeof CHOICE_FILTER_KEYS)[number];
export type FilterKey = (typeof FILTER_KEYS)[number];
export type NonViewFilterKey = (typeof NON_VIEW_FILTER_KEYS)[number];
