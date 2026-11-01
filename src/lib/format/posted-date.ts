/**
 * How a job's posted date is shown. Many sources give a date and no time, stored as UTC midnight; converting such a value
 * to the display zone would move it to the neighbouring day, so it keeps its UTC calendar day and shows no hours. A value
 * with a time is read in the display zone. Pure: `now` is always passed in.
 */
import { FORMAT_LABELS } from "@/i18n/locale";

import { formatInteger, intlLocale } from "./numbers";
import { calendarDaysBetween, dayParts, formatShortDate, type TimeOptions } from "./time";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The value is exactly UTC midnight: the source stated a day, not a time. */
export function isDateOnly(date: Date): boolean {
  return date.getTime() % DAY_MS === 0;
}

/** The zone the calendar day of `date` is read in: UTC for a date without a time, else the display zone. */
export function postedZone(date: Date, options: TimeOptions): string | undefined {
  return isDateOnly(date) ? "UTC" : options.timeZone;
}

/** `10/27` (`Oct 27`); another year than `now`'s adds it (`2025/10/27`, `Oct 27, 2025`); with `weekday` the short weekday follows (`10/27 Tue`). */
export function formatPostedDate(date: Date, now: Date, options: TimeOptions, extra: { weekday?: boolean } = {}): string {
  const zone = postedZone(date, options);
  const sameYear = dayParts(date, zone).year === dayParts(now, options.timeZone).year;
  const month = FORMAT_LABELS[options.locale].shortDateMonth;
  const tag = intlLocale(options.locale);
  const day = new Intl.DateTimeFormat(tag, {
    timeZone: zone,
    ...(sameYear ? {} : { year: "numeric" }),
    month,
    day: month === "2-digit" ? "2-digit" : "numeric",
  }).format(date);
  if (!extra.weekday) return day;
  return `${day} ${new Intl.DateTimeFormat(tag, { timeZone: zone, weekday: "short" }).format(date)}`;
}

type Ago = { unit: "now" | "today" | "yesterday"; n?: undefined } | { unit: "minutes" | "hours" | "days"; n: number };

function agoOf(date: Date, now: Date, options: TimeOptions): Ago {
  const days = (n: number): Ago => (n <= 0 ? { unit: "today" } : n === 1 ? { unit: "yesterday" } : { unit: "days", n });
  if (isDateOnly(date)) {
    const today = dayParts(now, options.timeZone);
    const day = dayParts(date, "UTC");
    return days(Math.round((Date.UTC(today.year, today.month - 1, today.day) - Date.UTC(day.year, day.month - 1, day.day)) / DAY_MS));
  }
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < 0) return { unit: "today" };
  if (elapsed < MINUTE_MS) return { unit: "now" };
  if (elapsed < HOUR_MS) return { unit: "minutes", n: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS) return { unit: "hours", n: Math.floor(elapsed / HOUR_MS) };
  return days(calendarDaysBetween(now, date, options.timeZone));
}

/**
 * Relative time of a posted date. With a time: `just now` / `5 min ago` / `5 h ago` inside a day, then calendar days in the
 * display zone (`yesterday`, `29 days ago`; never months). Without a time: the UTC day against today in the display zone
 * (`today`, `yesterday`, `N days ago`), never hours. A date in the future (clock skew) is `today`.
 */
export function formatPostedAgo(date: Date, now: Date, options: TimeOptions): string {
  const words = FORMAT_LABELS[options.locale].relative;
  const ago = agoOf(date, now, options);
  if (ago.n === undefined) return words[ago.unit];
  return words[ago.unit].replace("{n}", formatInteger(ago.n, options.locale));
}

/** The same in a few characters for a list column: `4 d`, `5 h`, `30 min` (`4 天`), and the words for just now / today / yesterday. */
export function formatPostedAgoShort(date: Date, now: Date, options: TimeOptions): string {
  const labels = FORMAT_LABELS[options.locale];
  const ago = agoOf(date, now, options);
  if (ago.n === undefined) return labels.relative[ago.unit];
  const unit = ago.unit === "days" ? labels.duration.d : ago.unit === "hours" ? labels.duration.h : labels.duration.m;
  return `${formatInteger(ago.n, options.locale)} ${unit}`;
}

/**
 * The full value for a tooltip: `2026-10-27 14:05` in the display zone, or `2026-10-27` for a date without a time. `zone` is the
 * zone name to print after it (null for a date without a time, which has none).
 */
export function formatPostedFull(date: Date, options: TimeOptions): { text: string; zone: string | null; dateOnly: boolean } {
  const dateOnly = isDateOnly(date);
  const parts = new Intl.DateTimeFormat(intlLocale(options.locale), {
    timeZone: postedZone(date, options),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }),
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${pick("year")}-${pick("month")}-${pick("day")}`;
  if (dateOnly) return { text: day, zone: null, dateOnly };
  return { text: `${day} ${pick("hour")}:${pick("minute")}`, zone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, dateOnly };
}

/** `10/27 09:12`: a moment of our own (never a source's date), in the display zone, to the minute. */
export function formatSeenAt(date: Date, now: Date, options: TimeOptions): string {
  const clock = new Intl.DateTimeFormat(intlLocale(options.locale), { timeZone: options.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${formatShortDate(date, now, options)} ${clock}`;
}
