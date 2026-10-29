const MS_PER_DAY = 24 * 3_600_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Window filtering treats bare calendar dates as a full day; timestamps retain their exact precision. */
export function postedDateEnd(value: string | null, postedAt: Date | null): number | null {
  if (postedAt === null) return null;
  return postedAt.getTime() + (value && DATE_ONLY.test(value.trim()) ? MS_PER_DAY : 0);
}
