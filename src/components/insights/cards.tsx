import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { Funnel, Ring, Waffle, type FunnelStep } from "@/components/viz";
import { useAppLocale } from "@/components/viz/intl";
import { knownFamily } from "@/lib/dashboard/labels";
import { formatFraction, formatInteger, formatPercent, formatSalary } from "@/lib/format/numbers";
import { EXCLUDE_REASON_CODES, type ExcludeReasonCode } from "@/lib/filter/reasons";
import type { InsightsView } from "@/lib/insights/view";
import { signalColorClasses } from "@/lib/signals/palette";
import { cn } from "@/lib/utils";

import { BarList, type BarRow } from "./bar-list";
import { ColumnChart, tickSets, type ChartColumn, type ChartMarker } from "./column-chart";
import { CardEmpty, InsightCard } from "./insight-card";
import "./insights.css";

/** Tick labels on a phone / from `sm` up: five or fewer on a phone, fourteen on a desktop. */
const PHONE_TICKS = 5;
const DESKTOP_TICKS = 12;

const linkClass = "text-ink-2 hover:bg-hi hover:text-hi-ink text-data rounded-[2px] underline decoration-dotted underline-offset-4";

/** Legend swatch: solid colour, or the hatch of "filtered out / not counted". */
function Swatch({ tone, hatch = false }: { tone: string; hatch?: boolean }) {
  return <i className={hatch ? "ins-hatch" : undefined} style={{ "--c": tone } as React.CSSProperties} aria-hidden />;
}

function useNumbers() {
  const format = useFormatter();
  const locale = useAppLocale();
  return {
    int: (value: number) => formatInteger(value, locale),
    /** `ratio` is 0 to 1. */
    percent: (ratio: number) => formatPercent(ratio * 100),
    /** `62/135 · 46%` (tokens.md number formats), never "62 of 135". */
    fraction: (part: number, whole: number) => formatFraction(part, whole, locale),
    decimal: (value: number) => format.number(value, { maximumFractionDigits: 1 }),
    format,
  };
}

/** Day columns: one per day of the range, passed (solid) on filtered out (hatched). */
export function DailyCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.daily");
  const tEmpty = useTranslations("insights.empty");
  const { int, decimal, format } = useNumbers();
  const { columns, maxTotal, perDay } = view.daily;
  const { phone: phoneTicks, desktop: deskTicks } = tickSets(columns.length, PHONE_TICKS, DESKTOP_TICKS);
  const dayLabel = (day: string, options: { weekday?: "short"; month: "short" | "numeric"; day: "numeric" }) => format.dateTime(new Date(`${day}T12:00:00Z`), { ...options, timeZone: "UTC" });

  const chartColumns: ChartColumn[] = columns.map((c, i) => ({
    key: c.day,
    text: t("column", { day: dayLabel(c.day, { weekday: "short", month: "short", day: "numeric" }), passed: int(c.passed), filtered: int(c.filtered) }),
    tick: deskTicks.has(i) || phoneTicks.has(i) ? dayLabel(c.day, { month: "numeric", day: "numeric" }) : null,
    tickOnPhone: phoneTicks.has(i),
    segments: [
      { value: c.passed, tone: "t4", href: c.passed > 0 ? c.passedHref : undefined, name: `${c.day}: ${t("passed")} ${c.passed}` },
      { value: c.filtered, tone: "ink", hatch: true, href: c.filtered > 0 ? c.filteredHref : undefined, name: `${c.day}: ${t("filtered")} ${c.filtered}` },
    ],
  }));

  return (
    <InsightCard
      title={t("title")}
      description={t("description")}
      testId="card-daily"
      aux={
        <span className="ins-legend">
          <span>
            <Swatch tone="var(--signal-t4)" />
            {t("passed")}
          </span>
          <span>
            <Swatch tone="var(--ink)" hatch />
            {t("filtered")}
          </span>
        </span>
      }
    >
      {view.kpi.total === 0 ? (
        <CardEmpty>{tEmpty("chart")}</CardEmpty>
      ) : (
        <>
          <p className="text-ink-2 text-data font-mono tabular-nums" data-testid="daily-average">
            {t("perDay", { count: decimal(perDay) })}
          </p>
          <ColumnChart columns={chartColumns} max={maxTotal} maxLabel={int(maxTotal)} {...(maxTotal >= 2 ? { midLabel: int(Math.round(maxTotal / 2)) } : {})} label={t("chart")} testId="daily-chart" />
        </>
      )}
    </InsightCard>
  );
}

function familyLabel(t: ReturnType<typeof useTranslations>, family: string): string {
  const known = knownFamily(family);
  return known ? t(`${known}`) : family;
}

export function SourcesCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.sources");
  const tFamily = useTranslations("dashboard.source");
  const { int, percent } = useNumbers();
  const { rows, maxTotal } = view.sources;
  const barRows: BarRow[] = rows.map((r) => ({
    key: r.family,
    label: familyLabel(tFamily, r.family),
    value: int(r.total),
    href: r.href,
    suffix: t("passRate", { rate: percent(r.passRate) }),
    suffixHref: r.passedHref,
    segments: [
      { value: r.passed, tone: "t4" },
      { value: r.total - r.passed, tone: "ink", hatch: true },
    ],
    text: t("row", { source: familyLabel(tFamily, r.family), total: int(r.total), passed: int(r.passed) }),
  }));
  return (
    <InsightCard
      title={t("title")}
      description={t("description")}
      testId="card-sources"
      aux={
        <span className="ins-legend">
          <span>
            <Swatch tone="var(--signal-t4)" />
            {t("legendPassed")}
          </span>
          <span>
            <Swatch tone="var(--ink)" hatch />
            {t("legendRest")}
          </span>
        </span>
      }
    >
      {rows.length === 0 ? <CardEmpty>{t("empty")}</CardEmpty> : <BarList rows={barRows} max={maxTotal} testId="sources-list" />}
    </InsightCard>
  );
}

export function CitiesCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.cities");
  const { int, percent, fraction } = useNumbers();
  const { rows, passed } = view.cities;
  const place = (row: (typeof rows)[number]): string => (row.kind === "city" ? (row.city ?? "") : row.kind === "remote" ? t("remote") : t("other"));
  const barRows: BarRow[] = rows.map((r) => ({
    key: r.kind === "city" ? `city:${r.city}` : r.kind,
    label: place(r),
    value: int(r.count),
    href: r.href,
    suffix: percent(r.share),
    segments: [r.kind === "other" ? { value: r.count, tone: "ink", hatch: true } : { value: r.count, tone: "t2" }],
    text: t("row", { place: place(r), fraction: fraction(r.count, passed) }),
  }));
  return (
    <InsightCard title={t("title")} description={t("description")} testId="card-cities" aux={t("aux")}>
      {passed === 0 ? <CardEmpty>{t("empty")}</CardEmpty> : <BarList rows={barRows} max={passed} testId="cities-list" />}
    </InsightCard>
  );
}

/** The four-step conversion of the range: fetched -> passed the filter -> at or above the push line -> applied. */
export function ConversionCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.conversion");
  const { conversion } = view;
  const steps: FunnelStep[] = [
    { key: "fetched", label: t("fetched"), value: conversion.fetched, tone: "ink" },
    { key: "passed", label: t("passed"), value: conversion.passed, tone: "t4" },
    { key: "pushable", label: t("pushable", { line: conversion.pushLine }), value: conversion.pushable, tone: "t2" },
    { key: "applied", label: t("applied"), value: conversion.applied, tone: "hi" },
  ];
  return (
    <InsightCard title={t("title")} description={t("description", { line: conversion.pushLine })} testId="card-conversion">
      {conversion.fetched === 0 ? <CardEmpty>{t("empty")}</CardEmpty> : <Funnel steps={steps} />}
    </InsightCard>
  );
}

/** Share of the new jobs that passed the filter, as 100 countable cells. */
export function PassRateCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.passRate");
  const { fraction } = useNumbers();
  const { kpi } = view;
  return (
    <InsightCard title={t("title")} testId="card-pass-rate">
      {kpi.passRate === null ? (
        <CardEmpty>{t("empty")}</CardEmpty>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Waffle value={kpi.passRate * 100} tone="t4" ariaLabel={t("aria")} />
          <div className="flex flex-col gap-1">
            <span className="text-ink-2 text-data font-mono">{t("caption")}</span>
            <span className="text-ink-2 text-data font-mono tabular-nums" data-testid="pass-rate-detail">
              {t("detail", { fraction: fraction(kpi.passed, kpi.total) })}
            </span>
          </div>
        </div>
      )}
    </InsightCard>
  );
}

/** How many of the passed jobs state a salary: a ring, with the comparable count and the median in words. */
export function DisclosureCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.salary");
  const appLocale = useAppLocale();
  const { int, percent, fraction } = useNumbers();
  const { salary } = view;
  return (
    <InsightCard title={t("disclosureTitle")} description={t("description")} testId="card-disclosure">
      {salary.passed === 0 || salary.rate === null ? (
        <CardEmpty>{t("empty")}</CardEmpty>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Ring value={salary.rate * 100} size="l" tone="hi" ariaLabel={t("disclosureAria")} caption={t("detailShort", { disclosed: int(salary.disclosed), total: int(salary.passed) })} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="sr-only" data-testid="salary-rate">
              {percent(salary.rate)}
            </span>
            <span className="text-ink-2 text-data font-mono" data-testid="salary-detail">
              {t("detail", { fraction: fraction(salary.disclosed, salary.passed) })}
            </span>
            <span className="text-ink-2 text-data font-mono tabular-nums">{t("comparable", { count: int(salary.comparable) })}</span>
            <span className="text-ink text-data font-mono font-semibold tabular-nums" data-testid="salary-median">
              {salary.medianEurPerYear === null
                ? t("medianFew", { days: view.rangeDays, count: int(salary.comparable), min: int(salary.minSample) })
                : t("median", { days: view.rangeDays, count: int(salary.comparable), amount: formatSalary({ min: salary.medianEurPerYear, max: salary.medianEurPerYear, currency: salary.currency }, { locale: appLocale }) ?? "" })}
            </span>
            <Link href={salary.href} className={cn(linkClass, "self-start")}>
              {t("open")}
            </Link>
          </div>
        </div>
      )}
    </InsightCard>
  );
}

/** Histogram of the stated annual salaries (range midpoints): the floor as a red line, the median dashed, bars below the floor hatched. */
export function SalaryCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.salary");
  const { int } = useNumbers();
  const appLocale = useAppLocale();
  // one way to write a single amount on the page (formatSalary: "€85.7k"), the median of the text card and of the chart alike
  const money = (eur: number): string => formatSalary({ min: eur, max: eur, currency: view.salary.currency }, { locale: appLocale }) ?? "";
  const { salary } = view;
  const barLabel = (bar: (typeof salary.bars)[number]): string =>
    bar.to === null ? t("bucketOpen", { from: bar.from / 1000 }) : t("bucketRange", { from: bar.from / 1000, to: bar.to / 1000 });
  const { phone: phoneTicks, desktop: deskTicks } = tickSets(salary.bars.length, 3, 8);
  const floor = salary.floorEur;
  const columns: ChartColumn[] = salary.bars.map((bar, i) => ({
    key: String(bar.index),
    text: t("bucket", { label: barLabel(bar), count: int(bar.count) }),
    tick: deskTicks.has(i) || phoneTicks.has(i) ? (bar.to === null ? `${bar.from / 1000}+` : String(bar.from / 1000)) : null,
    tickOnPhone: phoneTicks.has(i),
    segments: [{ value: bar.count, tone: "hi", hatch: floor !== null && bar.to !== null && bar.to <= floor }],
  }));
  const first = salary.bars[0]?.from ?? 0;
  const span = salary.bars.length * salary.bucketEur;
  const at = (eur: number): number => (span > 0 ? Math.min(100, Math.max(0, ((eur - first) / span) * 100)) : 0);
  const markers: ChartMarker[] = [];
  if (floor !== null && floor >= first && floor <= first + span) markers.push({ key: "floor", kind: "floor", position: at(floor), label: t("floorMark", { value: money(floor) }), tone: "bad", row: 0 });
  if (salary.medianEurPerYear !== null) markers.push({ key: "median", kind: "median", position: at(salary.medianEurPerYear), label: t("medianMark", { value: money(salary.medianEurPerYear) }), tone: "ink", row: 1 });
  return (
    <InsightCard
      title={t("title")}
      testId="card-salary"
      aux={t("unit")}
    >
      {salary.passed === 0 ? (
        <CardEmpty>{t("empty")}</CardEmpty>
      ) : columns.length === 0 ? (
        <CardEmpty>{t("noRanges")}</CardEmpty>
      ) : (
        <>
          <ColumnChart columns={columns} max={salary.maxCount} maxLabel={int(salary.maxCount)} label={t("chart")} testId="salary-chart" plotHeight="var(--space-8)" markers={markers} />
          <div className="ins-legend">
            <span>
              <Swatch tone="var(--hi)" />
              {t("legendBars")}
            </span>
            {floor !== null ? (
              <>
                <span>
                  <Swatch tone="var(--ink)" hatch />
                  {t("legendBelow")}
                </span>
                <span>
                  <i data-line="solid" style={{ "--c": "var(--bad)" } as React.CSSProperties} aria-hidden />
                  {t("floorMark", { value: money(floor) })}
                </span>
              </>
            ) : null}
            {salary.medianEurPerYear !== null ? (
              <span>
                <i data-line="dashed" style={{ "--c": "var(--ink)" } as React.CSSProperties} aria-hidden />
                {t("medianLegend", { days: view.rangeDays, count: int(salary.comparable), value: money(salary.medianEurPerYear) })}
              </span>
            ) : null}
          </div>
        </>
      )}
    </InsightCard>
  );
}

export function SignalsCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.signals");
  const { int, percent, decimal, fraction } = useNumbers();
  const { signals } = view;
  const rows: BarRow[] = [
    ...signals.tiers.map((tier): BarRow => ({
      key: tier.tier,
      label: (
        <span className="inline-flex items-baseline gap-2">
          {tier.code !== null ? <span className="font-mono">{tier.code}</span> : null}
          <span className="text-ink-2 line-clamp-2 min-w-0 font-sans text-data font-medium [overflow-wrap:anywhere]">{tier.label}</span>
        </span>
      ),
      value: int(tier.jobs),
      suffix: tier.avgRank === null ? percent(tier.share) : `${percent(tier.share)} · ${t("avgRank", { value: decimal(tier.avgRank) })}`,
      segments: [{ value: tier.jobs, tone: signalColorClasses(tier.color).tone }],
      text: t("row", { tier: tier.label, fraction: fraction(tier.jobs, signals.passed) }),
    })),
    {
      key: "none",
      label: <span className="text-ink-2">{t("none")}</span>,
      value: int(signals.withoutSignal),
      suffix: percent(signals.passed > 0 ? signals.withoutSignal / signals.passed : 0),
      segments: [{ value: signals.withoutSignal, tone: "ink", hatch: true }],
      text: t("row", { tier: t("none"), fraction: fraction(signals.withoutSignal, signals.passed) }),
    },
  ];
  return (
    <InsightCard title={t("title")} description={t("description")} testId="card-signals">
      {signals.passed === 0 ? (
        <CardEmpty>{t("empty")}</CardEmpty>
      ) : (
        <>
          <BarList rows={rows} max={signals.passed} testId="signals-list" />
          <div className="border-grid flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t-[1.5px] pt-3 text-data">
            {signals.highValueNames.length > 0 ? (
              <span className="text-ink-2">
                {t("highPay", { names: signals.highValueNames.join(" / ") })}:{" "}
                <Link href={signals.highPayHref} className="text-ink font-mono tabular-nums underline decoration-dotted underline-offset-4" data-testid="signals-highpay">
                  {int(signals.highPay)}
                </Link>
              </span>
            ) : (
              <span />
            )}
            {signals.avgRank === null ? null : <span className="text-ink-2 font-mono tabular-nums">{t("mean", { value: decimal(signals.avgRank) })}</span>}
          </div>
        </>
      )}
    </InsightCard>
  );
}

export function ScoresCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.scores");
  const { int, decimal } = useNumbers();
  const { scores } = view;
  const barLabel = (bar: (typeof scores.bars)[number]): string => (bar.to === null ? t("open", { from: bar.from }) : t("range", { from: bar.from, to: bar.to - 1 }));
  const { phone: phoneTicks } = tickSets(scores.bars.length, 5, 5);
  const columns: ChartColumn[] = scores.bars.map((bar, i) => ({
    key: String(bar.index),
    text: t("bucket", { label: barLabel(bar), count: int(bar.count) }),
    tick: phoneTicks.has(i) ? (bar.to === null ? `${bar.from}+` : String(bar.from)) : null,
    tickOnPhone: true,
    segments: [{ value: bar.count, tone: "meter", hatch: bar.from < view.conversion.pushLine }],
  }));
  const totalWidth = scores.bars.length * scores.bucketWidth;
  const pushPosition = totalWidth > 0 ? (view.conversion.pushLine / totalWidth) * 100 : 0;
  const markers: ChartMarker[] = pushPosition >= 0 && pushPosition <= 100 ? [{ key: "push", kind: "floor", position: pushPosition, label: t("pushLine", { line: view.conversion.pushLine }), tone: "bad", row: 0 }] : [];
  return (
    <InsightCard title={t("title")} description={t("description")} testId="card-scores">
      {scores.scored === 0 ? (
        <CardEmpty>{t("empty")}</CardEmpty>
      ) : (
        <>
          <div className="text-ink-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-data">
            <span className="font-mono tabular-nums" data-testid="scores-mean">
              {scores.avgRank === null ? null : t("mean", { value: decimal(scores.avgRank) })}
            </span>
            {scores.pending > 0 ? <span data-testid="scores-pending">{t("pending", { count: int(scores.pending) })}</span> : null}
          </div>
          <ColumnChart columns={columns} max={scores.maxCount} maxLabel={int(scores.maxCount)} label={t("chart")} testId="scores-chart" plotHeight="var(--space-8)" markers={markers} />
          <div className="ins-legend">
            <span>
              <Swatch tone="var(--meter)" />
              {t("legendPush", { line: view.conversion.pushLine })}
            </span>
            <span>
              <Swatch tone="var(--meter)" hatch />
              {t("legendBelow")}
            </span>
          </div>
        </>
      )}
    </InsightCard>
  );
}

/** The application pipeline over the range: how many applications moved into each stage, and the exits. */
export function FunnelCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.funnel");
  const tStatus = useTranslations("dashboard.status");
  const { int, percent } = useNumbers();
  const { funnel } = view;
  const stageLabel = (key: (typeof funnel.rows)[number]["key"]): string => (key === "new" ? t("new") : tStatus(key));
  const rows: BarRow[] = funnel.rows.map((r) => ({
    key: r.key,
    label: stageLabel(r.key),
    value: int(r.count),
    href: r.key === "new" ? view.kpi.hrefPassed : "/pipeline",
    suffix: r.conversion === null ? undefined : t("conversion", { rate: percent(r.conversion) }),
    segments: [r.key === "new" ? { value: r.width, tone: "ink", hatch: true } : { value: r.width, tone: "t4" }],
    text: t("row", { stage: stageLabel(r.key), count: int(r.count) }),
  }));
  const exits = (["rejected", "withdrawn", "archived"] as const).filter((key) => funnel.exits[key] > 0);
  return (
    <InsightCard title={t("title")} description={t("description")} testId="card-funnel">
      {!funnel.hasActivity ? (
        <>
          <BarList rows={rows.slice(0, 1)} max={1} testId="funnel-list" />
          <CardEmpty>{t("empty")}</CardEmpty>
        </>
      ) : (
        <>
          <BarList rows={rows} max={1} testId="funnel-list" />
          {exits.length > 0 ? (
            <p className="border-grid text-ink-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t-[1.5px] pt-3 text-data" data-testid="funnel-exits">
              <span>{t("exitsLabel")}</span>
              {exits.map((key) => (
                <span key={key} className="text-ink font-mono tabular-nums" data-exit={key}>
                  {t(key)} {int(funnel.exits[key])}
                </span>
              ))}
            </p>
          ) : null}
        </>
      )}
      <Link href="/pipeline" className={cn(linkClass, "self-start")}>
        {t("open")}
      </Link>
    </InsightCard>
  );
}

export function FiltersCard({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.filters");
  const { int, percent } = useNumbers();
  const { filters } = view;
  const isExcludeCode = (code: string): code is ExcludeReasonCode => (EXCLUDE_REASON_CODES as readonly string[]).includes(code);
  // a code the messages do not know (an older row) is shown as it is
  const reasonLabel = (code: string): string => (isExcludeCode(code) ? t(`code.${code}`) : code);
  const rows: BarRow[] = filters.rows.map((r) => ({
    key: r.code,
    label: reasonLabel(r.code),
    value: int(r.jobs),
    suffix: percent(r.share),
    segments: [{ value: r.jobs, tone: "ink", hatch: true }],
    text: t("row", { reason: reasonLabel(r.code), count: int(r.jobs) }),
  }));
  return (
    <InsightCard title={t("title")} description={filters.total > 0 ? t("description", { total: int(filters.total) }) : undefined} testId="card-filters">
      {filters.rows.length === 0 ? (
        <CardEmpty>{t("empty")}</CardEmpty>
      ) : (
        <>
          <BarList rows={rows} max={filters.maxJobs} testId="filters-list" />
          <Link href={filters.href} className={cn(linkClass, "self-start")}>
            {t("open")}
          </Link>
        </>
      )}
    </InsightCard>
  );
}
