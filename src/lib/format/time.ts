/**
 * Time formatting of docs/design/tokens.md "数字格式": relative time for lists, a full time for the
 * tooltip, durations. Pure: `now` is always passed in, so server and browser render the same text.
 *
 * Relative time: < 1 min "just now" · < 1 h "N min ago" · < 24 h "N h ago" · yesterday · earlier a date (Oct 5). The words
 * come from the locale's `format` namespace, the date style from `format.shortDateMonth` and `meta.intl`.
 */
import { FORMAT_LABELS, type Locale } from "@/i18n/locale";

import { formatInteger, intlLocale, UNKNOWN } from "./numbers";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Maybe = number | null | undefined;
type DateInput = Date | string | number | null | undefined;

export interface TimeOptions {
  locale: Locale;
  /** IANA zone the calendar day is counted in (`schedule.yaml: timezone`). Default: the runtime's zone. */
  timeZone?: string;
}

/** A valid Date, or null for anything else (null, "", an unparsable string). */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface DayParts {
  year: number;
  month: number;
  day: number;
}

function dayParts(date: Date, timeZone: string | undefined): DayParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

/** Calendar days between two dates in `timeZone` (1 = `date` is yesterday relative to `now`). */
function calendarDaysBetween(now: Date, date: Date, timeZone: string | undefined): number {
  const a = dayParts(now, timeZone);
  const b = dayParts(date, timeZone);
  return Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / DAY_MS);
}


/** Put a formatted number into a `{n}` word of the catalog. */
const withNumber = (word: string, n: string): string => word.replace("{n}", n);

/** Same year: `10/05` (`format.shortDateMonth: 2-digit`) or `Oct 5` (`short`); another year adds it (`2025/10/05`, `Oct 5, 2025`). */
export function formatShortDate(date: Date, now: Date, options: TimeOptions): string {
  const locale = options.locale;
  const sameYear = dayParts(date, options.timeZone).year === dayParts(now, options.timeZone).year;
  const month = FORMAT_LABELS[locale].shortDateMonth;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: options.timeZone,
    ...(sameYear ? {} : { year: "numeric" }),
    month,
    day: month === "2-digit" ? "2-digit" : "numeric",
  }).format(date);
}

/** `just now` / `5 min ago` / `5 h ago` / `yesterday` / `Oct 5`. A time in the future (clock skew) counts as just now. Unknown: `—`. */
export function formatRelativeTime(value: DateInput, now: Date, options: TimeOptions): string {
  const date = toDate(value);
  if (date === null) return UNKNOWN;
  const locale = options.locale;
  const words = FORMAT_LABELS[locale].relative;
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return words.now;
  if (elapsed < HOUR_MS) return withNumber(words.minutes, formatInteger(Math.floor(elapsed / MINUTE_MS), locale));
  if (elapsed < DAY_MS) return withNumber(words.hours, formatInteger(Math.floor(elapsed / HOUR_MS), locale));
  if (calendarDaysBetween(now, date, options.timeZone) === 1) return words.yesterday;
  return formatShortDate(date, now, options);
}

/** The full time for a tooltip: `2026-10-05 17:38`. */
export function formatFullTime(value: DateInput, options: TimeOptions): string {
  const date = toDate(value);
  if (date === null) return UNKNOWN;
  const parts = new Intl.DateTimeFormat(intlLocale(options.locale), {
    timeZone: options.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

/**
 * `16 d` · `1 d 4 h` · `3 h 20 min` · `3 min` · `45 s` (unit words from `format.duration`). At most two neighbouring units; never `384h`.
 * `milliseconds` is rounded to the nearest second first. Unknown or negative: `—`.
 */
export function formatDuration(milliseconds: Maybe, locale: Locale): string {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return UNKNOWN;
  const units = FORMAT_LABELS[locale].duration;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return seconds === 0 ? units.lessThanMinute : `${seconds} ${units.s}`;
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const part = (value: number, unit: string): string => `${formatInteger(value, locale)} ${unit}`;
  if (days > 0) return hours > 0 ? `${part(days, units.d)} ${part(hours, units.h)}` : part(days, units.d);
  if (hours > 0) return minutes > 0 ? `${part(hours, units.h)} ${part(minutes, units.m)}` : part(hours, units.h);
  return part(minutes, units.m);
}
