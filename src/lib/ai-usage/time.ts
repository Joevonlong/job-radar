/** `10-07 14:03:12` in `timeZone` (locale independent, so a log line reads the same in zh and en). */
export function formatLogTime(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
