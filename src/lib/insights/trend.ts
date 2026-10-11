/**
 * The rule for the trend line in a headline tile of /insights (one place, so the strip and its tests agree):
 *
 * - a day "has data" when the metric exists for it: a count above zero, a pass rate of a day that had jobs, a rank value of a
 *   day with scored jobs. Days without data are gaps in the series, never zeros;
 * - with at least `MIN_TREND_POINTS` days of data the trend is drawn as ONE continuous step line through those days (the gaps are
 *   bridged, so a series with holes is not broken into pieces and lonely dots);
 * - with fewer, no line is drawn and the tile says how many days it needs ("not enough data"), because one point is no trend.
 *
 * - the three lines of the strip share ONE x-range: it starts on the first day that had any job (`trendStart`), so none of them is a
 *   flat run of empty days followed by a few days squeezed into the last 20 px;
 *
 * `MIN_TREND_POINTS` is geometry, not a tunable threshold: a line needs two points.
 */
export const MIN_TREND_POINTS = 2;

export type TrendState = "line" | "insufficient";

/** Whether the series has enough days with data for a line; `present` says which values count as data (default: not null). */
export function trendState(values: ReadonlyArray<number | null>, present: (value: number | null) => boolean = (value) => value !== null): TrendState {
  return values.filter(present).length >= MIN_TREND_POINTS ? "line" : "insufficient";
}

/**
 * The values to draw: a value that is not data becomes a gap (null), so a day with no jobs does not pull a pass rate or a rank to zero.
 * Counts pass `present` = "above zero" only when zero means "nothing happened that day and the day should not count toward the line";
 * the daily new-jobs count keeps its zeros (a quiet day is a real value) and is only judged by `trendState`.
 */
export function trendValues(values: ReadonlyArray<number | null>, present: (value: number | null) => boolean = (value) => value !== null): Array<number | null> {
  return values.map((value) => (present(value) ? value : null));
}

/**
 * Index of the first day the shared x-range of the trend lines starts at: the first day `present` is true for (the first day with any
 * job), or 0 when there is none. Every line of the strip is cut at the same index, so they cover the same days and the same width.
 */
export function trendStart(values: ReadonlyArray<number | null>, present: (value: number | null) => boolean = (value) => value !== null): number {
  const index = values.findIndex(present);
  return index < 0 ? 0 : index;
}
