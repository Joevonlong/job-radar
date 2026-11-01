/** The decisions behind the salary panel that need no text or markup: which reason a row gets, which figures share the ruler. */
import type { SalaryBand } from "@/lib/salary/lookup-types";
import type { SalaryContext, SalaryLookupView } from "@/lib/salary/view";

/** One dot on the company row: a value and how many of the company's postings state it. */
export interface FigurePoint {
  value: number;
  count: number;
}

/** Equal figures become one point with a count (the company's postings are not capped, a popular figure must not pile up). */
export function groupFigures(figures: readonly number[]): FigurePoint[] {
  const counts = new Map<number, number>();
  for (const value of figures) if (Number.isFinite(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
}

/** What the "similar postings" row (and the second head cell) shows, in the order the reasons win over each other. */
export type GroupStatus = "config_error" | "not_ready" | "no_currency" | "no_family" | "stale" | "not_computed" | "no_group" | "group";

export function groupStatus(context: SalaryContext): GroupStatus {
  if (context.state === "config_error") return "config_error";
  if (context.state === "not_ready") return "not_ready";
  if (context.currency === "") return "no_currency";
  if (context.familyId === null) return "no_family";
  if (context.staleAi && !context.benchmarkEnabled) return "stale";
  if (context.group === null && !context.benchmarkComputed) return "not_computed";
  if (context.group === null) return "no_group";
  return "group";
}

/** Without a usable state or currency the group and the company row cannot say anything separately: one row gives the reason. */
export const groupRowIsCombined = (context: SalaryContext): boolean => context.state !== "ok" || context.currency === "";

/** How far the job's own figure is from the group's median, in whole percent (positive = above). Only the posting's own figure enters. */
export function versusMedian(figure: number | null, median: number | null): number | null {
  if (figure === null || median === null || median <= 0) return null;
  return Math.round(((figure - median) / median) * 100);
}

/** What the stored AI result gives the panel. Only `roleBand` is the role's number; the company-wide level never stands in for it. */
export type AiResult =
  | { kind: "none" }
  /** A result with no figure at all (no company median, no role band, no related roles). */
  | { kind: "empty" }
  /** Figures for the company but none for this role. */
  | { kind: "no_band" }
  /** A band that cannot be put on the ruler (another currency without a rate, or no bound stated). */
  | { kind: "text_only"; band: SalaryBand }
  | { kind: "band"; band: SalaryBand; min: number | null; max: number | null; median: number | null };

export function aiResultOf(latest: SalaryLookupView | null): AiResult {
  if (!latest) return { kind: "none" };
  const { roleBand, companyLevel, relatedRoles } = latest.result;
  if (roleBand === null) return companyLevel.median !== null || relatedRoles.length > 0 ? { kind: "no_band" } : { kind: "empty" };
  const drawable = roleBand.convertible && (roleBand.min !== null || roleBand.max !== null || roleBand.median !== null);
  return drawable ? { kind: "band", band: roleBand, min: roleBand.min, max: roleBand.max, median: roleBand.median } : { kind: "text_only", band: roleBand };
}

/** The figures of every row that is drawn, for the shared scale (`fitSalaryAxis`). */
export function rulerFigures(input: {
  jd: { min: number | null; max: number | null } | null;
  group: { quantiles: readonly number[]; median: number } | null;
  company: readonly number[];
  ai: AiResult;
  floor: number | null;
}): Array<number | null> {
  const { jd, group, ai } = input;
  return [
    jd?.min ?? null,
    jd?.max ?? null,
    group ? (group.quantiles[0] ?? group.median) : null,
    group ? group.median : null,
    group ? (group.quantiles[group.quantiles.length - 1] ?? group.median) : null,
    ...input.company,
    ai.kind === "band" ? ai.min : null,
    ai.kind === "band" ? ai.median : null,
    ai.kind === "band" ? ai.max : null,
    input.floor,
  ];
}
