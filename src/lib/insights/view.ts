import { isStageDrawn } from "@/lib/applications/visibility";
import { SCORE_BANDS } from "@/lib/dashboard/constants";
import type { InsightsConfig } from "@/lib/config";
import {
  FUNNEL_EXITS,
  FUNNEL_STAGES,
  type Bucket,
  type FunnelExit,
  type FunnelStage,
  type InsightsData,
} from "@/lib/db/repos/insights";

import type { CategoryView } from "@/lib/signals/catalog";
import type { SignalColor } from "@/lib/signals/palette";

import { jobsHref } from "./links";
import { eachDay, type DayWindow } from "./range";

/** Everything the /insights components draw, with the links already worked out. Pure: no I/O. */

export interface DayColumn {
  day: string;
  passed: number;
  filtered: number;
  /** Mean rank value of the day's passed jobs; null when none is scored. */
  avgRank: number | null;
  passedHref: string;
  /** The day's filtered-out jobs only: the list it opens has `filtered` jobs. */
  filteredHref: string;
}

export interface SourceRow {
  family: string;
  total: number;
  passed: number;
  /** passed / total, 0 to 1. */
  passRate: number;
  href: string;
  passedHref: string;
}

export interface CityRow {
  kind: "city" | "remote" | "other";
  /** The city name (kind `city`). */
  city: string | null;
  count: number;
  /** count / passed jobs, 0 to 1. */
  share: number;
  /** null when /jobs has no matching filter ("other"). */
  href: string | null;
}

export interface HistogramBar {
  index: number;
  /** Lower bound of the bucket (rank points, or EUR per year). */
  from: number;
  /** Upper bound (exclusive); null for the open-ended last bucket. */
  to: number | null;
  count: number;
}

export type ScoreBand = "low" | "mid" | "good" | "top";

export interface ScoreBar extends HistogramBar {
  band: ScoreBand;
}

export interface TierRow {
  /** Signal category id. */
  tier: string;
  /** Its name in the page language, its code (id up to 4 characters, else null) and colour. */
  label: string;
  code: string | null;
  color: SignalColor;
  jobs: number;
  /** jobs / passed jobs, 0 to 1. */
  share: number;
  avgRank: number | null;
}

export interface FunnelRow {
  key: "new" | FunnelStage;
  count: number;
  /** count / the previous stage, 0 to 1; null for the first stage, after an empty stage, and for "interested" when more were marked than appeared new. */
  conversion: number | null;
  /** Bar length against the longest stage, 0 to 1. */
  width: number;
}

export interface ReasonRow {
  code: string;
  jobs: number;
  /** jobs / filtered-out jobs, 0 to 1. */
  share: number;
}

export interface InsightsView {
  rangeDays: number;
  ranges: number[];
  window: DayWindow;
  /** No job in the window and no application activity: the page shows one empty state. */
  empty: boolean;
  kpi: {
    total: number;
    /** Relative change against the previous window; null when it had no jobs. */
    change: number | null;
    previousTotal: number;
    passed: number;
    passRate: number | null;
    /** Pass rate of the previous window, 0 to 1; null when it had no jobs. */
    previousPassRate: number | null;
    /** This window's pass rate minus the previous one, in percentage points; null when either is unknown. */
    passRateChangePt: number | null;
    salaryRate: number | null;
    avgRank: number | null;
    applied: number;
    hrefAll: string;
    hrefPassed: string;
    hrefSalary: string;
  };
  daily: { columns: DayColumn[]; maxTotal: number; perDay: number };
  sources: { rows: SourceRow[]; maxTotal: number };
  cities: { rows: CityRow[]; passed: number };
  salary: {
    passed: number;
    disclosed: number;
    comparable: number;
    rate: number | null;
    /** Median of the window's comparable salaries (`summarizeMonthSalaries`); null below `minSample`. */
    medianEurPerYear: number | null;
    /** `ui.yaml: salary_stats.min_sample`: how many comparable salaries a median needs. */
    minSample: number;
    /** `salary_floor_year` of preferences.yaml; null when none applies. */
    floorEur: number | null;
    /** The market's base currency every amount of the card is in ("" = unknown). */
    currency: string;
    /** Width of one bar, EUR. */
    bucketEur: number;
    bars: HistogramBar[];
    maxCount: number;
    href: string;
  };
  /** `highValueNames`: the high-value categories; empty = none, then there is no high-value figure. */
  signals: { passed: number; tiers: TierRow[]; withoutSignal: number; highPay: number; highPayHref: string; highValueNames: string[]; avgRank: number | null };
  scores: { bars: ScoreBar[]; /** Width of one bar, rank points. */ bucketWidth: number; maxCount: number; scored: number; pending: number; avgRank: number | null };
  funnel: { rows: FunnelRow[]; exits: Record<FunnelExit, number>; hasActivity: boolean };
  /** The four-step conversion of the window: fetched, passed the filter, at or above the push line, applied. */
  conversion: { fetched: number; passed: number; pushable: number; applied: number; pushLine: number };
  filters: { rows: ReasonRow[]; total: number; maxJobs: number; href: string };
}

export interface BuildViewInput {
  data: InsightsData;
  config: InsightsConfig;
  rangeDays: number;
  window: DayWindow;
  /** `notify.yaml: push_min_score`. */
  pushLine: number;
  salaryFloorEur?: number | null;
  /** (ui.yaml `applications.hidden_statuses`) A funnel stage that is hidden and has no jobs is not drawn. */
  hiddenStatuses?: readonly string[];
  /** The categories the signal card lists, as `getSignalStats` counted them; missing ones show their id. */
  categories?: readonly CategoryView[];
  /** Names of the high-value categories. */
  highValueNames?: readonly string[];
  /** The market's base currency. */
  currency?: string;
}

const ratio = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/** Buckets 0..capIndex with the gaps filled, optionally without the empty ones at either end (the cap bucket stays when it has jobs). */
function fillBuckets(buckets: readonly Bucket[], capIndex: number, width: number, trim: boolean): HistogramBar[] {
  const byIndex = new Map(buckets.map((b) => [b.index, b.count]));
  const all: HistogramBar[] = [];
  for (let index = 0; index <= capIndex; index += 1) {
    all.push({ index, from: index * width, to: index === capIndex ? null : (index + 1) * width, count: byIndex.get(index) ?? 0 });
  }
  if (!trim) return all;
  const filled = all.filter((bar) => bar.count > 0).map((bar) => bar.index);
  if (filled.length === 0) return [];
  const first = Math.min(...filled);
  const last = Math.max(...filled);
  return all.filter((bar) => bar.index >= first && bar.index <= last);
}

export function scoreBand(value: number): ScoreBand {
  if (value >= SCORE_BANDS.top) return "top";
  if (value >= SCORE_BANDS.good) return "good";
  if (value >= SCORE_BANDS.mid) return "mid";
  return "low";
}

export function buildInsightsView({ data, config, rangeDays, window, pushLine, salaryFloorEur = null, hiddenStatuses = [], categories = [], highValueNames = [], currency = "" }: BuildViewInput): InsightsView {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const dayCounts = new Map(data.daily.map((d) => [d.day, d]));
  const columns: DayColumn[] = eachDay(window.from, window.to).map((day) => {
    const counts = dayCounts.get(day);
    const range = { from: day, to: day };
    return {
      day,
      passed: counts?.passed ?? 0,
      filtered: counts?.filtered ?? 0,
      avgRank: counts?.avgRank ?? null,
      passedHref: jobsHref({ range }),
      filteredHref: jobsHref({ range, filteredOnly: true }),
    };
  });
  const passed = columns.reduce((sum, c) => sum + c.passed, 0);
  const filtered = columns.reduce((sum, c) => sum + c.filtered, 0);
  const total = passed + filtered;

  const passRate = total > 0 ? passed / total : null;
  const previousPassRate = data.previousTotal > 0 ? data.previousPassed / data.previousTotal : null;

  const funnelCounts = [{ key: "new" as const, count: data.funnel.newJobs }, ...FUNNEL_STAGES.map((key) => ({ key, count: data.funnel.reached[key] }))].filter((row) => row.key === "new" || isStageDrawn(row.key, hiddenStatuses, row.count));
  const longest = Math.max(1, ...funnelCounts.map((row) => row.count));
  const funnelRows: FunnelRow[] = funnelCounts.map((row, i) => {
    const previous = funnelCounts[i - 1];
    return {
      key: row.key,
      count: row.count,
      // every step says its share of the one before ("interested" had none). new -> interested is a rate only while the interested
      // jobs can have come from the new ones: more interested than new means some appeared before the window, and there is no share then
      conversion: i >= 1 && previous !== undefined && previous.count > 0 && (i >= 2 || row.count <= previous.count) ? row.count / previous.count : null,
      width: row.count / longest,
    };
  });
  const hasFunnelActivity = FUNNEL_STAGES.some((s) => data.funnel.reached[s] > 0) || FUNNEL_EXITS.some((s) => data.funnel.exits[s] > 0);

  const range = { from: window.from, to: window.to };
  const cityRows: CityRow[] = [
    ...data.cities.cities.map((c): CityRow => ({ kind: "city", city: c.city, count: c.count, share: ratio(c.count, data.cities.total), href: jobsHref({ range, city: c.city }) })),
    { kind: "remote", city: null, count: data.cities.remote, share: ratio(data.cities.remote, data.cities.total), href: jobsHref({ range, workplace: "remote" }) },
    { kind: "other", city: null, count: data.cities.other, share: ratio(data.cities.other, data.cities.total), href: null },
  ];

  const salaryBars = fillBuckets(data.salary.buckets, data.salaryCapIndex, config.salary_bucket, true);
  const scoreBars: ScoreBar[] = fillBuckets(data.scores.buckets, data.scoreCapIndex, config.score_bucket_width, false).map((bar) => ({ ...bar, band: scoreBand(bar.from) }));

  return {
    rangeDays,
    ranges: [...config.ranges_days],
    window,
    empty: total === 0 && !hasFunnelActivity,
    kpi: {
      total,
      change: data.previousTotal > 0 ? (total - data.previousTotal) / data.previousTotal : null,
      previousTotal: data.previousTotal,
      passed,
      passRate,
      previousPassRate,
      passRateChangePt: passRate !== null && previousPassRate !== null ? (passRate - previousPassRate) * 100 : null,
      salaryRate: data.salary.total > 0 ? data.salary.disclosed / data.salary.total : null,
      avgRank: data.signals.avgRank,
      applied: data.funnel.reached.applied,
      hrefAll: jobsHref({ range, filtered: true }),
      hrefPassed: jobsHref({ range }),
      hrefSalary: jobsHref({ range, salary: true }),
    },
    daily: { columns, maxTotal: Math.max(1, ...columns.map((c) => c.passed + c.filtered)), perDay: columns.length > 0 ? total / columns.length : 0 },
    sources: {
      rows: data.sources.map((s) => ({
        family: s.family,
        total: s.total,
        passed: s.passed,
        passRate: ratio(s.passed, s.total),
        href: jobsHref({ range, source: s.family, filtered: true }),
        passedHref: jobsHref({ range, source: s.family }),
      })),
      maxTotal: Math.max(1, ...data.sources.map((s) => s.total)),
    },
    cities: { rows: cityRows, passed: data.cities.total },
    salary: {
      passed: data.salary.total,
      disclosed: data.salary.disclosed,
      comparable: data.salary.comparable,
      rate: data.salary.total > 0 ? data.salary.disclosed / data.salary.total : null,
      medianEurPerYear: data.salary.medianEurPerYear,
      minSample: data.salary.minSample,
      floorEur: salaryFloorEur,
      currency,
      bucketEur: config.salary_bucket,
      bars: salaryBars,
      maxCount: Math.max(1, ...salaryBars.map((b) => b.count)),
      href: jobsHref({ range, salary: true }),
    },
    signals: {
      passed: data.signals.total,
      tiers: data.signals.tiers.map((t) => {
        const category = categoryById.get(t.tier);
        return { tier: t.tier, label: category?.label ?? t.tier, code: category ? category.code : t.tier, color: category?.color ?? "neutral", jobs: t.jobs, share: ratio(t.jobs, data.signals.total), avgRank: t.avgRank };
      }),
      withoutSignal: data.signals.withoutSignal,
      highPay: data.signals.highPay,
      highPayHref: jobsHref({ range, high: true }),
      highValueNames: [...highValueNames],
      avgRank: data.signals.avgRank,
    },
    scores: { bars: scoreBars, bucketWidth: config.score_bucket_width, maxCount: Math.max(1, ...scoreBars.map((b) => b.count)), scored: data.scores.scored, pending: data.scores.pending, avgRank: data.scores.avgRank },
    funnel: { rows: funnelRows, exits: data.funnel.exits, hasActivity: hasFunnelActivity },
    conversion: { fetched: total, passed, pushable: data.scores.atPushLine, applied: data.funnel.reached.applied, pushLine },
    filters: {
      rows: data.filters.reasons.map((r) => ({ code: r.code, jobs: r.jobs, share: ratio(r.jobs, data.filters.total) })),
      total: data.filters.total,
      maxJobs: Math.max(1, ...data.filters.reasons.map((r) => r.jobs)),
      // the filtered-out jobs of the range only: the list it opens has `total` jobs
      href: jobsHref({ range, filteredOnly: true }),
    },
  };
}
