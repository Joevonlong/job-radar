import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { Delta, NumberRoll, PercentBar, type NumberRollFormat } from "@/components/viz";
import { useAppLocale } from "@/components/viz/intl";
import { formatFraction, formatPercent, ratioPercent } from "@/lib/format/numbers";
import { MIN_TREND_POINTS, trendStart, trendState, trendValues } from "@/lib/insights/trend";
import type { InsightsView } from "@/lib/insights/view";
import { cn } from "@/lib/utils";

import { FitSparkline } from "./fit-sparkline";

interface TileProps {
  label: string;
  testId: string;
  hero?: boolean;
  /** The number, already a link or a roll. */
  children: ReactNode;
  /** A ratio bar under the number (what share of what). */
  bar?: ReactNode;
  /** Change against the previous window and the trend line. */
  foot?: ReactNode;
  /** One line of words under the figures (the graphics never stand alone). */
  hint: ReactNode;
}

function Tile({ label, testId, hero = false, children, bar, foot, hint }: TileProps) {
  return (
    <Card className={cn("min-w-0 gap-1.5 px-4 py-3", hero && "bg-hi text-hi-ink")} data-testid={testId}>
      <h2 className={cn("font-mono text-data font-semibold tracking-[0.04em]", hero ? "text-hi-ink" : "text-ink-2")}>{label}</h2>
      <p className={cn("font-display tabular-nums", hero ? "text-num-xl" : "text-num-l")}>{children}</p>
      {bar}
      {foot ? <div className="flex items-end justify-between gap-2">{foot}</div> : null}
      <p className={cn("text-data leading-snug", hero ? "text-hi-ink" : "text-ink-2")}>{hint}</p>
    </Card>
  );
}

const valueLink = "decoration-dotted underline-offset-4 hover:underline rounded-[2px]";
const PERCENT: NumberRollFormat = "percent";

/**
 * The four headline numbers over the cards: what arrived (hero), how much of it passed the filter, how good it is,
 * how far it got. Changing the range rolls each number from the old value to the new one (NumberRoll keeps its place).
 */
export function KpiStrip({ view }: { view: InsightsView }) {
  const t = useTranslations("insights.kpi");
  const format = useFormatter();
  const locale = useAppLocale();
  const { kpi, daily } = view;
  const change = kpi.change === null ? null : format.number(kpi.change, { style: "percent", maximumFractionDigits: 0, signDisplay: "exceptZero" });
  const totals = daily.columns.map((c) => c.passed + c.filtered);
  const passRates = daily.columns.map((c) => (c.passed + c.filtered > 0 ? (c.passed / (c.passed + c.filtered)) * 100 : null));
  const ranks = daily.columns.map((c) => c.avgRank);
  // the rule is in `lib/insights/trend.ts`: days without data are bridged in one continuous line; fewer than two days of data: words, no line
  // `keepZeros`: the daily count keeps its quiet days (0 jobs is a real value) and only needs two busy days to count as a trend
  // all three lines start on the first day with any job: the same days, the same width
  const from = trendStart(totals, (value) => value !== null && value > 0);
  const trend = (
    all: ReadonlyArray<number | null>,
    format: "integer" | "percent" = "integer",
    width = 130,
    present: (value: number | null) => boolean = (value) => value !== null,
    keepZeros = false,
    onHero = false,
  ) => {
    const values = all.slice(from);
    if (trendState(values, present) === "insufficient") {
      return (
        // on the yellow card the words are ink on the highlight, like the rest of that card (ink-3 on it was 2:1 in the terminal theme)
        <span className={cn("text-data-sm font-mono", onHero ? "text-hi-ink" : "text-ink-3")} data-testid="trend-insufficient">
          {t("trendNone", { count: MIN_TREND_POINTS })}
        </span>
      );
    }
    return <FitSparkline values={keepZeros ? values : trendValues(values, present)} width={width} height={30} format={format} bridgeGaps />;
  };
  const inFlow = (value: number | null) => value !== null && value > 0;
  const appliedShare = ratioPercent(kpi.applied, kpi.passed);

  return (
    <section aria-label={t("label")} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1.3fr_repeat(3,minmax(0,1fr))]" data-testid="kpi-strip">
      <Tile
        label={t("new")}
        testId="kpi-new"
        hero
        foot={
          <>
            {kpi.change === null ? <span /> : <Delta value={kpi.change * 100} unit="%" />}
            {trend(totals, "integer", 170, inFlow, true, true)}
          </>
        }
        hint={change === null ? t("newChangeNone", { days: view.rangeDays }) : t("newChange", { change, days: view.rangeDays })}
      >
        <Link href={kpi.hrefAll} className={valueLink} data-testid="kpi-new-value">
          <NumberRoll value={kpi.total} />
        </Link>
      </Tile>

      <Tile
        label={t("passed")}
        testId="kpi-passed"
        bar={<PercentBar value={kpi.passRate === null ? null : kpi.passRate * 100} tone="t4" label={false} ariaLabel={t("passedBar")} className="w-full" />}
        foot={
          <>
            {kpi.passRateChangePt === null ? <span /> : <Delta value={kpi.passRateChangePt} unit="pt" />}
            {trend(passRates, "percent")}
          </>
        }
        hint={
          kpi.passRate === null ? (
            t("none")
          ) : (
            <>
              <Link href={kpi.hrefPassed} className={valueLink} data-testid="kpi-passed-count">
                {t("passedCount", { fraction: formatFraction(kpi.passed, kpi.total, locale) })}
              </Link>
            </>
          )
        }
      >
        <span data-testid="kpi-passed-value">
          <NumberRoll value={kpi.passRate === null ? null : kpi.passRate * 100} format={PERCENT} />
        </span>
      </Tile>

      <Tile label={t("rank")} testId="kpi-rank" bar={<PercentBar value={kpi.avgRank} tone="t2" threshold={view.conversion.pushLine} label={false} ariaLabel={t("rankBar", { line: view.conversion.pushLine })} className="w-full" />} foot={trend(ranks)} hint={t("rankHint")}>
        <span data-testid="kpi-rank-value">
          <NumberRoll value={kpi.avgRank} format="decimal" />
        </span>
      </Tile>

      <Tile
        label={t("applied")}
        testId="kpi-applied"
        bar={<PercentBar value={appliedShare} tone="hi" label={appliedShare === null ? false : formatPercent(appliedShare)} ariaLabel={t("appliedBar")} className="w-full" />}
        hint={t("appliedHint")}
      >
        <Link href="/pipeline" className={valueLink} data-testid="kpi-applied-value">
          <NumberRoll value={kpi.applied} />
        </Link>
      </Tile>
    </section>
  );
}
