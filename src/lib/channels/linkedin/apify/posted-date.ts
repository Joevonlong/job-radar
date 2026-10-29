import { z } from "zod";

import type { DateEvidence, DateEvidenceFlag } from "../date-window";

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

/** Only a valid full calendar date or an ISO instant can become a LinkedIn provider's posting time. */
export function postedAtOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const dateOnly = dateSchema.safeParse(text).success;
  if (!dateOnly && !instantSchema.safeParse(text).success) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  return !dateOnly || at.toISOString().slice(0, 10) === text ? at : null;
}

function relativeAge(value: string | null | undefined): { count: number; unitMs: number } | null {
  const match = /^(\d+)\s+(second|minute|hour|day|week)s?\s+ago$/i.exec(value ?? "");
  if (!match?.[1] || !match[2]) return null;
  const count = Number(match[1]);
  const unitMs = RELATIVE_UNITS_MS[match[2].toLowerCase()];
  return Number.isSafeInteger(count) && unitMs !== undefined ? { count, unitMs } : null;
}

/**
 * Apify can serialize a day as ISO midnight. Only a consistent seconds/minutes/hours label confirms that midnight
 * is hour-precise. A present but unparseable or conflicting label also removes confidence in a non-midnight time. Relative text
 * supplies a rounded age interval, never a replacement postedAt; keep the source date and raw payload unchanged.
 */
export function postedDateEvidence(record: Record<string, unknown>, observedAt: number): DateEvidence {
  const { postedDate, postedTimeAgo } = timeFieldsSchema.parse(record);
  const at = postedAtOf(postedDate);
  if (at === null) return { end: null, flags: [record.postedDate == null ? "date_missing" : "date_unparsed"] };
  const timestamp = at.getTime();
  if (dateSchema.safeParse(postedDate).success) return { end: timestamp + MS_PER_DAY, flags: ["date_day_precision"] };
  const time = ISO_TIME.exec(postedDate ?? "");
  if (!time) return { end: null, flags: ["date_unparsed"] };
  const timeOfDay = Number(time[1]) * MS_PER_HOUR + Number(time[2]) * 60_000 + Number(time[3] ?? 0) * 1000 + at.getUTCMilliseconds();
  const relative = relativeAge(postedTimeAgo);
  // "5 hours ago" covers ages from 5 to under 6 hours; no arbitrary clock-skew tolerance is added.
  const agrees = relative !== null && Math.floor((observedAt - timestamp) / relative.unitMs) === relative.count;
  const exact = timeOfDay === 0
    ? agrees && relative !== null && relative.unitMs <= MS_PER_HOUR
    : postedTimeAgo === undefined || agrees;
  // The source's offset is retained: subtract its stated time-of-day, not the converted UTC time-of-day.
  const end = exact ? timestamp : timestamp - timeOfDay + MS_PER_DAY;
  const flags: DateEvidenceFlag[] = [];
  if (!exact && timeOfDay === 0) flags.push("date_day_precision");
  if (!exact && timeOfDay !== 0 && relative === null) flags.push("date_unconfirmed");
  if (relative !== null && !agrees) flags.push("date_conflict");
  return { end, flags };
}

export function postedBefore(record: Record<string, unknown>, cutoff: number, observedAt: number): boolean {
  const { end } = postedDateEvidence(record, observedAt);
  return end !== null && end < cutoff;
}
