import { useFormatter, useTranslations } from "next-intl";

import { ColumnChart, tickSets, type ChartColumn } from "@/components/insights/column-chart";
import { CardEmpty, InsightCard } from "@/components/insights/insight-card";
import type { VizTone } from "@/components/viz/util";
import { toneVar } from "@/components/viz/util";
import { AI_PROVIDER_IDS, type AiProviderIdChoice } from "@/lib/config/ai-options";
import { type AiUsageMetric, type AiUsageUrlState } from "@/lib/ai-usage/params";
import { niceAxisMax } from "@/lib/ai-usage/axis";
import type { AiUsageView } from "@/lib/ai-usage/view";

import "@/components/insights/insights.css";
import "./ai-usage.css";
import { MetricSwitch } from "./metric-switch";
import { useUsdText } from "./usage-cells";

/** Interface colours of the providers (not a setting): a provider keeps its colour on every chart. */
export const PROVIDER_TONE: Record<AiProviderIdChoice, VizTone> = { "codex-cli": "t4", "claude-cli": "t3", deepseek: "t2", anthropic: "t1", mimo: "ink" };

const PHONE_TICKS = 5;
const DESKTOP_TICKS = 10;

/** One column per day of the range, stacked by provider; the metric (tokens / equivalent cost / calls) is a URL parameter. */
export function DailyCard({ view, state, metric }: { view: AiUsageView; state: AiUsageUrlState; metric: AiUsageMetric }) {
  const t = useTranslations("aiUsage.daily");
  const format = useFormatter();
  const { days } = view;
  const { phone, desktop } = tickSets(days.length, PHONE_TICKS, DESKTOP_TICKS);
  const dayLabel = (day: string, options: { weekday?: "short"; month: "short" | "numeric"; day: "numeric" }) => format.dateTime(new Date(`${day}T12:00:00Z`), { ...options, timeZone: "UTC" });
  const usd = useUsdText();
  const compact = (value: number) => format.number(value, { notation: "compact", maximumFractionDigits: 1 });
  const show = (value: number) => (metric === "equivalent" ? usd(value) : format.number(value));
  const valueOf = (slot: { calls: number; tokens: number; equivalentUsd: number }) => (metric === "tokens" ? slot.tokens : metric === "equivalent" ? slot.equivalentUsd : slot.calls);

  const present = AI_PROVIDER_IDS.filter((id) => view.days.some((d) => d.byProvider[id] !== undefined));
  const columns: ChartColumn[] = days.map((d, i) => {
    const parts = AI_PROVIDER_IDS.flatMap((id) => {
      const slot = d.byProvider[id];
      return slot && valueOf(slot) > 0 ? [`${id} ${show(valueOf(slot))}`] : [];
    });
    return {
      key: d.day,
      text: t("column", { day: dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" }), parts: parts.length > 0 ? parts.join(" · ") : t("none") }),
      tick: desktop.has(i) || phone.has(i) ? dayLabel(d.day, { month: "numeric", day: "numeric" }) : null,
      tickOnPhone: phone.has(i),
      segments: AI_PROVIDER_IDS.map((id) => ({ value: d.byProvider[id] ? valueOf(d.byProvider[id]) : 0, tone: PROVIDER_TONE[id], name: `${d.day}: ${id}` })),
    };
  });
  // the axis stops at a round number whose half is round too (whole tokens and calls, no 7172.5 ticks)
  const max = niceAxisMax(Math.max(0, ...columns.map((c) => c.segments.reduce((sum, s) => sum + s.value, 0))), metric !== "equivalent");
  const axis = (value: number) => (metric === "equivalent" ? usd(value) : compact(value));
  return (
    <InsightCard
      title={t("title")}
      description={t("description")}
      testId="ai-daily-card"
      aux={
        <span className="ins-legend">
          {present.map((id) => (
            <span key={id}>
              <i style={{ "--c": toneVar(PROVIDER_TONE[id]) } as React.CSSProperties} aria-hidden />
              {id}
            </span>
          ))}
        </span>
      }
    >
      <MetricSwitch state={state} active={metric} />
      {max === 0 ? (
        <CardEmpty>{t("none")}</CardEmpty>
      ) : (
        <div className="ai-chart" data-testid="ai-daily-chart" data-metric={metric}>
          <ColumnChart columns={columns} max={max} maxLabel={axis(max)} {...(max > 0 ? { midLabel: axis(max / 2) } : {})} label={t("chart")} testId="ai-daily-chart-plot" />
        </div>
      )}
      {metric !== "calls" && view.totals.tokenUnknownCalls > 0 ? <p className="text-ink-2 text-data">{t("unknownNote")}</p> : null}
    </InsightCard>
  );
}
