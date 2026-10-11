/** Time window of /sources/ai-usage: pure functions over `YYYY-MM-DD` day strings in the schedule's time zone. */
import { addDays, windowEnding } from "@/lib/insights/range";

export const AI_USAGE_RANGE_KINDS = ["today", "7d", "30d", "month", "custom"] as const;
export type AiUsageRangeKind = (typeof AI_USAGE_RANGE_KINDS)[number];
export type AiUsageDefaultRange = Exclude<AiUsageRangeKind, "custom">;

export interface ResolvedRange {
  kind: AiUsageRangeKind;
  /** First and last day, inclusive. */
  from: string;
  to: string;
  days: number;
  /** A custom range was asked for but is not usable: the default range is shown instead. */
  invalid: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day (2026-02-30 is not). */
export function isDay(value: string | null | undefined): value is string {
  if (value === null || value === undefined || !DAY.test(value)) return false;
  return addDays(value, 0) === value;
}

/** Days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function fixed(kind: AiUsageDefaultRange, today: string): { from: string; to: string } {
  switch (kind) {
    case "today": return { from: today, to: today };
    case "7d": return windowEnding(today, 7);
    case "30d": return windowEnding(today, 30);
    case "month": return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

export interface RangeParams {
  range: AiUsageRangeKind | null;
  from: string | null;
  to: string | null;
}

export function resolveAiUsageRange(
  params: RangeParams,
  options: { today: string; defaultRange: AiUsageDefaultRange; customMaxDays: number },
): ResolvedRange {
  const { today } = options;
  const make = (kind: AiUsageRangeKind, window: { from: string; to: string }, invalid: boolean): ResolvedRange => ({
    kind,
    ...window,
    days: daysBetween(window.from, window.to),
    invalid,
  });
  if (params.range === "custom") {
    const { from, to } = params;
    if (isDay(from) && isDay(to) && from <= to && to <= today && daysBetween(from, to) <= options.customMaxDays) {
      return make("custom", { from, to }, false);
    }
    return make(options.defaultRange, fixed(options.defaultRange, today), true);
  }
  const kind = params.range ?? options.defaultRange;
  return make(kind, fixed(kind, today), false);
}
