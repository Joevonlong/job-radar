/**
 * The date filter of /jobs: quick ranges (`within=7d`, `within=month`) and which date a range or a custom `from` / `to` compares
 * (`dateBy`). Pure constants and functions shared by the client (filter bar, chips) and the server (URL parsing, list query).
 *
 * The grammar below is a URL contract (links, bookmarks and saved views carry it), not a tunable: only the list of ranges the filter
 * offers and the default `dateBy` are configuration (ui.yaml `filters.date_quick_ranges` / `date_default_field`).
 */

/** Longest rolling range, in days. A URL contract: changing it would break existing links. */
export const WITHIN_MAX_DAYS = 366;

/** `Nd` with N in 1..WITHIN_MAX_DAYS (checked by `parseWithin`); a URL contract. */
const WITHIN_DAYS_PATTERN = /^([1-9]\d{0,2})d$/;

/** The token of the calendar-month range. */
export const WITHIN_MONTH = "month";

/** A quick range: the last N×24 hours, or the current calendar month in the display time zone. */
export type WithinRange = { kind: "days"; days: number } | { kind: "month" };

/** `7d` / `month` as a range; anything else (`0d`, `367d`, `7`, `7D`, `foo`) is null. */
export function parseWithin(value: string): WithinRange | null {
  if (value === WITHIN_MONTH) return { kind: "month" };
  const match = WITHIN_DAYS_PATTERN.exec(value);
  if (!match) return null;
  const days = Number(match[1]);
  return days <= WITHIN_MAX_DAYS ? { kind: "days", days } : null;
}

/** The URL / config token of a range (`7d`, `month`). */
export function formatWithin(range: WithinRange): string {
  return range.kind === "month" ? WITHIN_MONTH : `${range.days}d`;
}

export function sameWithin(a: WithinRange | null | undefined, b: WithinRange | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return formatWithin(a) === formatWithin(b);
}

/** Which date the filter compares: `posted` = the posted date, the first-seen date where a posting has none; `seen` = first seen. */
export const DATE_FIELDS = ["posted", "seen"] as const;
export type DateField = (typeof DATE_FIELDS)[number];

/** The ranges the filter offers and the date it compares when ui.yaml says nothing (its schema defaults are these). */
export const DEFAULT_DATE_QUICK_RANGES: readonly string[] = ["1d", "7d", "14d", WITHIN_MONTH];
export const DEFAULT_DATE_FIELD: DateField = "posted";

/** The date inputs of the URL (`within`, `dateBy`, `from`, `to`). */
export interface DateParams {
  within?: WithinRange | null;
  dateBy?: DateField | null;
  from?: string | null;
  to?: string | null;
}

export interface EffectiveDateRange {
  within: WithinRange | null;
  from: string | null;
  to: string | null;
  /** Null while no date condition is set (a bare `dateBy` filters nothing). */
  dateField: DateField | null;
}

/**
 * What the list query gets from the URL's date inputs. One definition for the list, its counts, "mark all seen" and the filter bar:
 * - `within` wins over `from` / `to` when a hand-written URL has both;
 * - an inverted `from` / `to` pair (from after to) is swapped;
 * - without `dateBy` the dates are first-seen dates (what links, saved views and MCP calls meant before the posted date existed).
 */
export function effectiveDateRange(params: DateParams): EffectiveDateRange {
  const within = params.within ?? null;
  const first = within ? null : (params.from ?? null);
  const last = within ? null : (params.to ?? null);
  // a hand-written `from` after `to` would match nothing: read it as the span between the two dates
  const inverted = first !== null && last !== null && first > last;
  const from = inverted ? last : first;
  const to = inverted ? first : last;
  const hasCondition = within !== null || from !== null || to !== null;
  return { within, from, to, dateField: hasCondition ? (params.dateBy ?? "seen") : null };
}

/** Whether a date condition (a quick range or a custom `from` / `to`) is set. */
export function hasDateCondition(params: DateParams): boolean {
  const { within, from, to } = effectiveDateRange(params);
  return within !== null || from !== null || to !== null;
}

/** The "by" the filter bar shows: the URL's, else `seen` for an old `from` / `to` link, else the configured default. */
export function displayedDateField(params: DateParams, configuredDefault: DateField): DateField {
  if (params.dateBy) return params.dateBy;
  return hasDateCondition(params) ? "seen" : configuredDefault;
}

/** The range group's selection: a quick range token, `custom` (a `from` / `to` pair), or `any`. */
export type DateRangeChoice = { kind: "any" } | { kind: "custom" } | { kind: "within"; within: WithinRange };

export function dateRangeChoice(params: DateParams): DateRangeChoice {
  const { within, from, to } = effectiveDateRange(params);
  if (within) return { kind: "within", within };
  if (from || to) return { kind: "custom" };
  return { kind: "any" };
}
