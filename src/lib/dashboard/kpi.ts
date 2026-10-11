/**
 * The five summary blocks of Today: fetched, passed the filter, at or above the push line, salary stated, pushed.
 * `buildKpiBlocks` turns the per-cycle counts of `listRecentCycleKpis` (oldest first, the last one is the cycle on show) into what a
 * block prints: the value, its share of what was fetched, the change against the previous cycle and the series for the trend line.
 */
import type { KpiBlockKey, UnprocessedReason } from "@/lib/cycle/step-health";
import { ratioPercent } from "@/lib/format/numbers";

/** Counts of one cycle (see `listRecentCycleKpis` for what each one means). `qualified` is null when no push line applies. */
export interface CycleKpiCounts {
  cycleId: number;
  fetched: number;
  passed: number;
  qualified: number | null;
  salaryStated: number;
  pushed: number;
  /** Postings of the cycle still waiting for the pipeline; absent = 0. */
  unprocessed?: number;
  /** Blocks that cannot be trusted because a step they depend on failed (`unprocessedBlocks`); absent = none. */
  unprocessedBlocks?: Partial<Record<KpiBlockKey, UnprocessedReason>>;
}

export const KPI_KEYS = ["fetched", "passed", "qualified", "salary", "pushed"] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export interface KpiBlock {
  key: KpiKey;
  /** The cycle on show; null = unknown (never 0). */
  value: number | null;
  /** Share of the fetched postings, 0-100; null when nothing was fetched or the value is unknown. */
  share: number | null;
  /** Change against the previous cycle; null when there is no previous cycle or one of the two is unknown. */
  delta: number | null;
  /** Last cycles, oldest first, ending with `value`. Null = unknown for that cycle (a gap in the line). */
  series: Array<number | null>;
  /**
   * The step behind this block failed in the cycle on show, so its count would be a fake 0. `value` is then null; `count` is how many
   * fetched postings wait for processing (null when that is not what is missing, e.g. only the AI score is).
   */
  pending: { reason: UnprocessedReason; count: number | null; fetched: number | null } | null;
}

function pick(counts: CycleKpiCounts, key: KpiKey): number | null {
  if (key !== "fetched" && counts.unprocessedBlocks?.[key]) return null;
  switch (key) {
    case "fetched":
      return counts.fetched;
    case "passed":
      return counts.passed;
    case "qualified":
      return counts.qualified;
    case "salary":
      return counts.salaryStated;
    case "pushed":
      return counts.pushed;
  }
}

/** `cycles`: oldest first, at most `trendCycles` of them are used. No cycles: no blocks. */
export function buildKpiBlocks(cycles: readonly CycleKpiCounts[], trendCycles: number): KpiBlock[] {
  const window = cycles.slice(-Math.max(1, trendCycles));
  const current = window[window.length - 1];
  if (!current) return [];
  const previous = window.length > 1 ? window[window.length - 2] : undefined;
  return KPI_KEYS.map((key) => {
    const value = pick(current, key);
    const before = previous ? pick(previous, key) : null;
    const reason = key === "fetched" ? undefined : current.unprocessedBlocks?.[key];
    return {
      key,
      pending: reason ? { reason, // only the blocks that wait for the pipeline have "postings waiting"; a failed push has no such number
      count: reason === "unprocessed" && key !== "pushed" ? (current.unprocessed ?? 0) : null,
      fetched: reason === "unprocessed" && key !== "pushed" ? Math.max(current.fetched, current.unprocessed ?? 0) : current.fetched } : null,
      value,
      share: key === "fetched" ? null : ratioPercent(value, current.fetched),
      delta: value !== null && before !== null ? value - before : null,
      series: window.map((counts) => pick(counts, key)),
    };
  });
}
