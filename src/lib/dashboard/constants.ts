/** Rows per page on /jobs (server-side pagination). */
export const JOBS_PAGE_SIZE = 50;

/** A list with more rows than this renders only the rows in (or near) the viewport. */
export const VIRTUALIZE_ROWS_ABOVE = 100;

/** Rough row heights for the virtualizer before a row is measured (desktop / phone card). */
export const ESTIMATED_ROW_HEIGHT = { desktop: 92, mobile: 150 } as const;

/** Rank-value colour bands from docs/design/tokens.md: >= top, >= good, >= mid, else low. */
export const SCORE_BANDS = { top: 85, good: 70, mid: 50 } as const;

/** Status a job with no application is shown as. */
export const DEFAULT_APPLICATION_STATUS = "new" as const;
