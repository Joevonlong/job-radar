/**
 * Day arithmetic of /insights. Days are `YYYY-MM-DD` strings in the schedule's time zone (what the `from` / `to`
 * filters of /jobs and the SQL day buckets use), so no `Date` maths in local time can shift a day.
 */

const DAY_MS = 86_400_000;

/** The calendar day of an instant in an IANA time zone. */
export function dayInZone(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** `day` moved by `delta` days (negative = earlier). */
export function addDays(day: string, delta: number): string {
  const moved = new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS);
  return moved.toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface DayWindow {
  from: string;
  to: string;
}

/** The `days` days ending on `today` (included). */
export function windowEnding(today: string, days: number): DayWindow {
  return { from: addDays(today, -(days - 1)), to: today };
}

/** The window of the same length right before `window`. */
export function previousWindow(window: DayWindow, days: number): DayWindow {
  return { from: addDays(window.from, -days), to: addDays(window.from, -1) };
}

/** The range the URL asks for when the config offers it, else the default. */
export function resolveRangeDays(requested: number | null | undefined, offered: readonly number[], fallback: number): number {
  return requested !== null && requested !== undefined && offered.includes(requested) ? requested : fallback;
}
