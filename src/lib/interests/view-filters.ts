/**
 * Saved views: conversions between the filters of a view (interests.yaml) and the query
 * parameters of /jobs and the Today page. Pure, free of server-only imports: the client (save
 * button, tabs) and the server (pages, actions) share it.
 */
import type { SavedView, ViewFilters } from "@/lib/config/schemas/interests";
import { FILTER_KEYS, MULTI_FILTER_KEYS, NON_VIEW_FILTER_KEYS, SCALAR_COMPAT_KEYS, TOGGLE_FILTER_KEYS, type FilterKey, type MultiFilterKey, type NonViewFilterKey } from "@/lib/jobs/filter-keys";
import { sortMultiValues, type MultiValue } from "@/lib/jobs/filter-values";
import type { JobsSearchParams } from "@/lib/jobs/search-params";

/** Filter keys of a view, in the order they are listed (the filter table of `filter-keys.ts`). */
export type ViewFilterKey = Exclude<FilterKey, NonViewFilterKey>;
const isViewKey = (key: FilterKey): key is ViewFilterKey => !(NON_VIEW_FILTER_KEYS as readonly string[]).includes(key);
export const VIEW_FILTER_KEYS = FILTER_KEYS.filter(isViewKey) satisfies ReadonlyArray<keyof ViewFilters>;

/** The toggles (`true` = on) among the filters. */
export const VIEW_TOGGLE_KEYS = TOGGLE_FILTER_KEYS.filter(isViewKey);

type FilterParams = Pick<JobsSearchParams, ViewFilterKey>;

/** The values of a multi filter of a view, in the order they were written: a scalar is a one-element list, absent is empty. */
export function filterValues<K extends Exclude<MultiFilterKey, NonViewFilterKey>>(filters: ViewFilters, key: K): MultiValue<K>[] {
  const value = filters[key] as MultiValue<K> | MultiValue<K>[] | undefined;
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

const isScalarCompat = (key: MultiFilterKey): boolean => (SCALAR_COMPAT_KEYS as readonly string[]).includes(key);

/** The filters currently set in the /jobs URL state; unset values and `false` toggles are left out. */
export function viewFiltersFromParams(params: Partial<FilterParams>): ViewFilters {
  const filters: ViewFilters = {};
  const q = params.q?.trim();
  if (q) filters.q = q;
  // One value is written as a scalar (what the file looked like before multi-value filters), several as a list; `app` and `company` are always a list.
  // Enum filters are written in their canonical order, whatever order the URL listed them in.
  const multi: Record<string, string | string[]> = {};
  for (const key of MULTI_FILTER_KEYS) {
    if (!isViewKey(key)) continue;
    const picked = (params[key] ?? []) as MultiValue<typeof key>[];
    if (picked.length === 0) continue;
    const values = sortMultiValues(key, picked) as string[];
    multi[key] = values.length === 1 && isScalarCompat(key) ? (values[0] as string) : values;
  }
  Object.assign(filters, multi);
  if (params.minScore !== null && params.minScore !== undefined) filters.minScore = params.minScore;
  if (params.minSalary !== null && params.minSalary !== undefined) filters.minSalary = params.minSalary;
  if (params.from) filters.from = params.from;
  if (params.to) filters.to = params.to;
  if (params.salary === true) filters.salary = true;
  if (params.filtered === true) filters.filtered = true;
  if (params.hideLang === true) filters.hideLang = true;
  if (params.high === true) filters.high = true;
  if (params.trap) filters.trap = params.trap;
  if (params.visa) filters.visa = params.visa;
  // `ghost=all` is "no filter": a view never stores it
  if (params.ghost && params.ghost !== "all") filters.ghost = params.ghost;
  return filters;
}

/** `/jobs` URL state of a view (every filter key present, `null` / `[]` = not set); feed it to the nuqs serializer. */
export function viewFiltersToParams(filters: ViewFilters): FilterParams {
  return {
    q: filters.q ?? null,
    source: filterValues(filters, "source"),
    city: filterValues(filters, "city"),
    company: filterValues(filters, "company"),
    workplace: filterValues(filters, "workplace"),
    contract: filterValues(filters, "contract"),
    status: filterValues(filters, "status"),
    app: filterValues(filters, "app"),
    minScore: filters.minScore ?? null,
    minSalary: filters.minSalary ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null,
    salary: filters.salary === true ? true : null,
    filtered: filters.filtered === true ? true : null,
    hideLang: filters.hideLang === true ? true : null,
    high: filters.high === true ? true : null,
    trap: filters.trap ?? null,
    visa: filters.visa ?? null,
    ghost: filters.ghost === undefined || filters.ghost === "all" ? null : filters.ghost,
  };
}

/** Keys of `filters` that are set. */
export function activeFilterKeys(filters: ViewFilters): ViewFilterKey[] {
  return VIEW_FILTER_KEYS.filter((key) => filters[key] !== undefined && filters[key] !== false && !(key === "ghost" && filters.ghost === "all"));
}

export function hasViewFilters(filters: ViewFilters): boolean {
  return activeFilterKeys(filters).length > 0;
}

/** A filter value in the form two views are compared by: multi filters as lists (enums in canonical order, free text as written). */
function comparable(filters: ViewFilters, key: ViewFilterKey): unknown {
  if ((MULTI_FILTER_KEYS as readonly string[]).includes(key)) {
    const multiKey = key as Exclude<MultiFilterKey, NonViewFilterKey>;
    return sortMultiValues(multiKey, filterValues(filters, multiKey));
  }
  return filters[key];
}

/** Same filters, whatever the key order (and `"Berlin"` = `["Berlin"]`). */
export function sameFilters(a: ViewFilters, b: ViewFilters): boolean {
  const keys = activeFilterKeys(a);
  return keys.length === activeFilterKeys(b).length && keys.every((key) => JSON.stringify(comparable(a, key)) === JSON.stringify(comparable(b, key)));
}

const MAX_ID_CHARS = 40;

/**
 * An id for a new view (`^[a-z0-9][a-z0-9-]*$`) from its name: ASCII letters and digits kept (accents dropped: ü = u), everything
 * else becomes a dash; a name without any (Chinese) becomes `view`. A taken id gets `-2`, `-3` ...
 */
export function slugifyViewId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_CHARS)
    .replace(/-+$/g, "");
  const base = slug === "" ? "view" : slug;
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------- Today

/** The Today toggles as the URL carries them: `null` = not in the URL (`high` also reads the old `t12`, see `withLegacyKeys`). */
export interface TodayToggleParams {
  filtered: boolean | null;
  hideLang: boolean | null;
  high: boolean | null;
}

export const TODAY_ALL_VIEW = "all";

export interface TodayViewState {
  /** The view whose filters apply, or null for "all". */
  active: SavedView | null;
  /** The view is applied only because it is the default (no `view` and no toggle in the URL). */
  implicit: boolean;
  /** Filters that apply: the view's, with the toggles of the URL on top. */
  filters: ViewFilters;
}

/**
 * Which view the Today page shows.
 * - `view=all`: no view; `view=<id>`: that view (an unknown id means no view);
 * - no `view`: the default view, but only when the URL carries no toggle either (explicit parameters win);
 * - a toggle in the URL overrides the same filter of the view (`hideLang=false` turns the view's off).
 * The dates of a view are dropped: Today is today.
 */
export function resolveTodayView(views: readonly SavedView[], view: string | null, toggles: TodayToggleParams): TodayViewState {
  const explicit = toggles.filtered !== null || toggles.hideLang !== null || toggles.high !== null;
  let active: SavedView | null = null;
  let implicit = false;
  if (view === null) {
    if (!explicit) {
      active = views.find((v) => v.default) ?? null;
      implicit = active !== null;
    }
  } else if (view !== TODAY_ALL_VIEW) {
    active = views.find((v) => v.id === view) ?? null;
  }
  const filters: ViewFilters = { ...(active?.filters ?? {}) };
  delete filters.from;
  delete filters.to;
  for (const key of ["filtered", "hideLang", "high"] as const) {
    const value = toggles[key];
    if (value === null) continue;
    if (value) filters[key] = true;
    else delete filters[key];
  }
  return { active, implicit, filters };
}

/** Today URL for `view` (`null` = no `view` parameter) and toggles; a toggle equal to what the view says is left out. */
export function todayHref(options: { view: string | null; toggles: { filtered: boolean; hideLang: boolean; high: boolean }; viewFilters?: ViewFilters; /** A built-in quick view (`high` / `salary` / `following`); the whole list when absent. */ quick?: string | null }): string {
  const query = new URLSearchParams();
  if (options.view !== null) query.set("view", options.view);
  if (options.quick) query.set("quick", options.quick);
  for (const key of ["filtered", "hideLang", "high"] as const) {
    const wanted = options.toggles[key];
    const fromView = options.viewFilters?.[key] === true;
    if (wanted !== fromView) query.set(key, wanted ? "true" : "false");
  }
  const text = query.toString();
  return text === "" ? "/" : `/?${text}`;
}
