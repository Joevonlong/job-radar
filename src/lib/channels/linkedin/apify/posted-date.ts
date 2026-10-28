import { z } from "zod";

import { postedAtOf } from "../brightdata/parse";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const RELATIVE_UNITS_MS: Readonly<Record<string, number>> = {
  second: 1000,
  minute: 60_000,
  hour: MS_PER_HOUR,
  day: MS_PER_DAY,
  week: 7 * MS_PER_DAY,
};

// Read only the time metadata before filtering; malformed/missing fields provide no precision evidence.
const timeFieldsSchema = z.object({
  postedDate: z.string().trim().nullish().catch(null),
  postedTimeAgo: z.string().trim().nullish().catch(null),
});
const dateSchema = z.iso.date();
const instantSchema = z.iso.datetime({ offset: true });
const ISO_TIME = /T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function relativeAge(value: string | null | undefined): { count: number; unitMs: number } | null {
  const match = /^(\d+)\s+(second|minute|hour|day|week)s?\s+ago$/i.exec(value ?? "");
  if (!match?.[1] || !match[2]) return null;
  const count = Number(match[1]);
  const unitMs = RELATIVE_UNITS_MS[match[2].toLowerCase()];
  return Number.isSafeInteger(count) && unitMs !== undefined ? { count, unitMs } : null;
}

/**
 * Apify can serialize a day as ISO midnight. Only a consistent seconds/minutes/hours label confirms that midnight
 * is hour-precise. A recognizable conflicting label also removes confidence in a non-midnight time. Relative text
 * supplies a rounded age interval, never a replacement postedAt; keep the source date and raw payload unchanged.
 */
export function postedBefore(record: Record<string, unknown>, cutoff: number, observedAt: number): boolean {
  const { postedDate, postedTimeAgo } = timeFieldsSchema.parse(record);
  const at = postedAtOf(postedDate);
  if (at === null) return false;
  const timestamp = at.getTime();
  if (dateSchema.safeParse(postedDate).success) return timestamp + MS_PER_DAY < cutoff;
  // Other date formats cannot establish time precision or an unambiguous source calendar day.
  if (!instantSchema.safeParse(postedDate).success) return false;
  const time = ISO_TIME.exec(postedDate ?? "");
  if (!time) return false;
  const timeOfDay = Number(time[1]) * MS_PER_HOUR + Number(time[2]) * 60_000 + Number(time[3] ?? 0) * 1000 + at.getUTCMilliseconds();
  const relative = relativeAge(postedTimeAgo);
  // "5 hours ago" covers ages from 5 to under 6 hours; no arbitrary clock-skew tolerance is added.
  const agrees = relative !== null && Math.floor((observedAt - timestamp) / relative.unitMs) === relative.count;
  const exact = timeOfDay === 0
    ? agrees && relative !== null && relative.unitMs <= MS_PER_HOUR
    : relative === null || agrees;
  // The source's offset is retained: subtract its stated time-of-day, not the converted UTC time-of-day.
  const end = exact ? timestamp : timestamp - timeOfDay + MS_PER_DAY;
  return end < cutoff;
}
