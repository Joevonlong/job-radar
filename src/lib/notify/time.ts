/** Local-time helpers for quiet hours and the daily reminder (everything is evaluated in schedule.yaml's time zone). */

interface LocalParts {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
}

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`localParts: cannot format ${type} for ${timeZone}`);
    return value;
  };
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** "HH:MM" → minutes since midnight. The config schema guarantees the format. */
export function clockMinutes(clock: string): number {
  const [h, m] = clock.split(":");
  return Number(h) * 60 + Number(m);
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function localDate(date: Date, timeZone: string): string {
  return localParts(date, timeZone).date;
}

/** `MM-DD HH:mm` of `date` in `timeZone` (message headers). */
export function formatLocalShort(date: Date, timeZone: string): string {
  const { date: d, minutes } = localParts(date, timeZone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${d.slice(5)} ${hh}:${mm}`;
}

/** `HH:mm` of `date` in `timeZone`; `MM-DD HH:mm` when it falls on another local day than `now`. */
export function formatLocalTime(date: Date, timeZone: string, now: Date): string {
  const short = formatLocalShort(date, timeZone);
  return localDate(date, timeZone) === localDate(now, timeZone) ? short.slice(6) : short;
}

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

/**
 * Is `now` inside the quiet window? The window is [start, end) and may cross midnight
 * (22:00–07:00). `start == end` is an empty window (never quiet).
 */
export function isQuietHours(now: Date, timeZone: string, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const start = clockMinutes(quiet.start);
  const end = clockMinutes(quiet.end);
  if (start === end) return false;
  const minutes = localParts(now, timeZone).minutes;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Is the daily reminder due? It is once the local time has reached `sendAt` and no reminder was
 * handled yet on the same local date — so a runner that was down at 09:00 still sends it later that day.
 */
export function isReminderDue(input: { now: Date; timeZone: string; sendAt: string; lastHandledAt: Date | null }): boolean {
  const now = localParts(input.now, input.timeZone);
  if (now.minutes < clockMinutes(input.sendAt)) return false;
  return input.lastHandledAt === null || localParts(input.lastHandledAt, input.timeZone).date !== now.date;
}
