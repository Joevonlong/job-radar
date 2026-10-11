/**
 * Geometry of the 24 h timeline on the /settings schedule tab. Pure: the component draws what
 * these functions return, and the unit tests pin the numbers (cron slots, time zone, quiet hours that
 * cross midnight). Everything is in minutes since local midnight of the schedule's time zone.
 */
import { CronPattern } from "croner";

export const MINUTES_PER_DAY = 24 * 60;

/** The weekday cycles run Monday to Friday, the weekend cycle Saturday and Sunday: cron weekdays 1-5 / 6, 0. */
const WEEKDAY_NUMBERS = [1, 2, 3, 4, 5] as const;
const WEEKEND_NUMBERS = [0, 6] as const;

export type RunKind = "weekday" | "weekend" | "daily";

export interface CycleInput {
  id: string;
  cron: string;
  enabled: boolean;
}

export interface TimelineRun {
  /** The cycle (`weekday_morning` ...) this slot belongs to. */
  id: string;
  /** Minutes since local midnight. */
  minutes: number;
  kind: RunKind;
  /** False: the cycle is switched off in the file; the timeline still shows its slots, dimmed. */
  enabled: boolean;
}

/** Slots (minutes of the day) and weekdays a 5-field cron fires on; null when it does not parse. Day-of-month and month are ignored: the timeline is a typical day. */
export function cronSlots(cron: string): { minutes: number[]; kind: RunKind } | null {
  let pattern: CronPattern;
  try {
    pattern = new CronPattern(cron.trim().split(/\s+/).join(" "));
  } catch {
    return null;
  }
  const on = (flags: number[]): number[] => flags.flatMap((flag, index) => (flag ? [index] : []));
  const minutes = on(pattern.minute);
  const hours = on(pattern.hour);
  const weekdays = new Set(on(pattern.dayOfWeek));
  const onWeekday = WEEKDAY_NUMBERS.some((day) => weekdays.has(day));
  const onWeekend = WEEKEND_NUMBERS.some((day) => weekdays.has(day));
  if (minutes.length === 0 || hours.length === 0 || (!onWeekday && !onWeekend)) return null;
  const kind: RunKind = onWeekday && onWeekend ? "daily" : onWeekday ? "weekday" : "weekend";
  return { minutes: hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute)).sort((a, b) => a - b), kind };
}

/** Every slot of every cycle with a valid cron, ordered by time; the switched-off cycles are in it too, marked `enabled: false`. */
export function timelineRuns(cycles: readonly CycleInput[]): TimelineRun[] {
  const runs: TimelineRun[] = [];
  for (const cycle of cycles) {
    const slots = cronSlots(cycle.cron);
    if (slots === null) continue;
    for (const minutes of slots.minutes) runs.push({ id: cycle.id, minutes, kind: slots.kind, enabled: cycle.enabled });
  }
  return runs.sort((a, b) => a.minutes - b.minutes);
}

export interface QuietInput {
  enabled: boolean;
  /** "HH:MM". */
  start: string;
  end: string;
}

export interface QuietSegment {
  from: number;
  to: number;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" -> minutes, or null when it is not a clock time. */
export function clockToMinutes(clock: string): number | null {
  const match = CLOCK.exec(clock.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** The quiet window as one or two segments of the day: [start, end) may cross midnight (22:00-07:00 = 22:00-24:00 and 00:00-07:00). `start == end` is empty (never quiet). */
export function quietSegments(quiet: QuietInput | null): QuietSegment[] {
  if (quiet === null || !quiet.enabled) return [];
  const start = clockToMinutes(quiet.start);
  const end = clockToMinutes(quiet.end);
  if (start === null || end === null || start === end) return [];
  if (start < end) return [{ from: start, to: end }];
  return [
    { from: 0, to: end },
    { from: start, to: MINUTES_PER_DAY },
  ].filter((segment) => segment.to > segment.from);
}

/** Minutes since local midnight of `now` in `timeZone`; null for a zone the runtime does not know. */
export function minutesNow(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
    return pick("hour") * 60 + pick("minute");
  } catch {
    return null;
  }
}

/** Position on the 24 h axis, 0-100 %. */
export function dayPercent(minutes: number): number {
  return Math.round((Math.min(Math.max(minutes, 0), MINUTES_PER_DAY) / MINUTES_PER_DAY) * 10_000) / 100;
}

/** `07:05` for minutes since midnight (24:00 stays 24:00). */
export function clockText(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** What a cron means in words: the kind of days and the clock times of the day; null when it does not parse. */
export interface CronMeaning {
  kind: RunKind;
  /** "07:00" ... in order. */
  times: string[];
}

export function describeCron(cron: string): CronMeaning | null {
  const slots = cronSlots(cron);
  return slots === null ? null : { kind: slots.kind, times: slots.minutes.map(clockText) };
}
