/** A profile date (`2021`, `2021-03`, `present`) as a month index, or null when it is not set. A bare year starts in January and ends in December. */
function monthIndex(date: string | null, today: string, edge: "start" | "end"): number | null {
  if (date === null) return null;
  const value = date === "present" ? today.slice(0, 7) : date;
  const match = /^(\d{4})(?:-(\d{2}))?/.exec(value);
  if (!match) return null;
  const month = match[2] === undefined ? (edge === "start" ? 1 : 12) : Number(match[2]);
  return Number(match[1]) * 12 + month - 1;
}

/**
 * Years of experience from experience ranges: overlapping or adjacent ranges count once, `present` is `today` (an ISO date
 * the caller passes), a range without an end is one month, one without a start is left out. Null when no range is usable.
 * Rounded to one decimal.
 */
export function yearsOfExperience(ranges: readonly { start: string | null; end: string | null }[], today: string): number | null {
  const spans = ranges
    .map((range) => {
      const start = monthIndex(range.start, today, "start");
      if (start === null) return null;
      const end = monthIndex(range.end, today, "end") ?? start;
      return end < start ? null : ([start, end + 1] as const);
    })
    .filter((span): span is readonly [number, number] => span !== null)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return null;
  let months = 0;
  let [from, to] = spans[0]!;
  for (const [start, end] of spans.slice(1)) {
    if (start <= to) to = Math.max(to, end);
    else {
      months += to - from;
      [from, to] = [start, end];
    }
  }
  months += to - from;
  return Math.round((months / 12) * 10) / 10;
}
