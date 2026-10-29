import type { DeliveryFlag } from "../delivery";

const MS_PER_DAY = 24 * 3_600_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type DateEvidenceFlag = Extract<DeliveryFlag, `date_${string}`>;
export interface DateEvidence {
  end: number | null;
  flags: DateEvidenceFlag[];
}

export function postedDateEvidence(value: string | null, postedAt: Date | null): DateEvidence {
  const dayPrecision = value !== null && DATE_ONLY.test(value.trim());
  return {
    end: postedAt === null ? null : postedAt.getTime() + (dayPrecision ? MS_PER_DAY : 0),
    flags: value === null ? ["date_missing"] : postedAt === null ? ["date_unparsed"] : dayPrecision ? ["date_day_precision"] : [],
  };
}

/** Window filtering treats bare calendar dates as a full day; timestamps retain their exact precision. */
export function postedDateEnd(value: string | null, postedAt: Date | null): number | null {
  return postedDateEvidence(value, postedAt).end;
}
