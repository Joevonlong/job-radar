import { DEFAULT_SORT_DIR, JOB_SORTS, type JobScope, type JobSort, type SortDir } from "./constants";

/** One sort contract for URLs, list queries and controls; an explicit rank must remain distinct from no sort. */
export function resolveSort(input: { sort: JobSort | null; q: string | null; scope: JobScope }): JobSort {
  // 1. A valid explicit sort always wins.
  if (input.sort !== null && JOB_SORTS.includes(input.sort)) return input.sort;

  // 2. Search text defaults to relevance, ahead of scope defaults.
  if (input.q?.trim()) return "relevance";

  // 3. The archive defaults to the newest source listing.
  if (input.scope === "archive") return "last_listed";
  // 4. Every other scope defaults to rank.
  return "rank";
}

/**
 * Sorting /jobs from the list's column heads. Pure (client and server): the page works out the links of the heads with
 * these, the filter bar's direction button uses `effectiveDir`, so a head, the drop-down and the button always agree on the URL.
 */

/** The list columns that sort, and the sort each one stands for (the other columns do not sort). */
export const SORTABLE_COLUMNS = { score: "rank", salary: "salary", fresh: "first_seen" } as const satisfies Record<string, JobSort>;
export type SortableColumn = keyof typeof SORTABLE_COLUMNS;

/** The direction a list is really sorted in: the URL's `dir`, else the sort's default. */
export function effectiveDir(sort: JobSort, dir: SortDir | null | undefined): SortDir {
  return sort === "relevance" ? "desc" : dir ?? DEFAULT_SORT_DIR[sort];
}

/** The other direction. */
export function flipDir(dir: SortDir): SortDir {
  return dir === "asc" ? "desc" : "asc";
}

/** `dir` as the URL writes it: the sort's default direction is left out (null), so `?sort=rank` stays the canonical link. */
export function dirParam(sort: JobSort, dir: SortDir): SortDir | null {
  return sort === "relevance" || dir === DEFAULT_SORT_DIR[sort] ? null : dir;
}

/**
 * What a click on a column head does: on the column the list is sorted by, the direction flips; on another column, that column's
 * sort with its default direction. Either way back to page 1.
 */
export function nextSortParams(column: SortableColumn, current: { sort: JobSort; dir: SortDir | null | undefined }): { sort: JobSort; dir: SortDir | null; page: 1 } {
  const sort = SORTABLE_COLUMNS[column];
  if (sort === current.sort) return { sort, dir: dirParam(sort, flipDir(effectiveDir(sort, current.dir))), page: 1 };
  return { sort, dir: null, page: 1 };
}

/** The column a sort belongs to; null for a sort without a column (`posted`, `last_listed`). */
export function columnOfSort(sort: JobSort): SortableColumn | null {
  for (const [column, columnSort] of Object.entries(SORTABLE_COLUMNS) as Array<[SortableColumn, JobSort]>) if (columnSort === sort) return column;
  return null;
}
