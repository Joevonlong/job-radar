/** The `dateTime` part of a next-intl formatter (`useFormatter()` in the browser, `getFormatter()` on the server). */
export interface ClockFormatter {
  dateTime(value: Date, options: { hour: "2-digit"; minute: "2-digit"; hourCycle: "h23"; timeZone?: string }): string;
}

/** `14:30` (24-hour) of an ISO time in `timeZone` (default: the runtime's); "" for a time that does not parse. */
export function formatClock(format: ClockFormatter, iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return format.dateTime(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) });
}
