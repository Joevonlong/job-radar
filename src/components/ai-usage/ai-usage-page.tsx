import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { CardEmpty } from "@/components/insights/insight-card";
import type { AiUsagePageData } from "@/lib/ai-usage/load";
import { AI_USAGE_METRICS } from "@/lib/ai-usage/params";

import { BreakdownTable } from "./breakdown-table";
import { CallLog } from "./call-log";
import { DailyCard } from "./daily-card";
import { FilterChips } from "./filter-chips";
import { KpiTiles } from "./kpi-tiles";
import { RangePicker } from "./range-picker";

/** The body of /sources/ai-usage: range, filters, headline numbers, the daily chart, three breakdowns, the call log, footnotes. */
export function AiUsagePage({ data }: { data: AiUsagePageData }) {
  const t = useTranslations("aiUsage");
  const format = useFormatter();
  const { view, state } = data;
  const { range, totals } = view;
  const metric = AI_USAGE_METRICS.find((m) => m === state.metric) ?? "tokens";
  const missing = view.missingEquivalentModels.map((m) => `${m.provider} ${m.model}`).join(", ");
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="ai-usage" data-range={range.kind}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <RangePicker state={state} active={range.kind} from={range.from} to={range.to} today={data.today} />
        <span className="text-ink-2 text-data font-mono" data-testid="ai-usage-window">
          {t("range.window", { from: range.from, to: range.to, zone: data.timeZone })}
        </span>
      </div>
      {range.invalid ? <Badge variant="gate-warn" className="h-auto w-fit max-w-full whitespace-normal py-1" role="status" data-testid="ai-usage-invalid">{t("range.invalid")}</Badge> : null}
      <FilterChips state={state} />
      {view.empty ? (
        <CardEmpty>{t("empty")}</CardEmpty>
      ) : (
        <>
          <KpiTiles totals={totals} />
          <DailyCard view={view} state={state} metric={metric} />
          <BreakdownTable title={t("breakdown.byModel")} rows={view.byModel} kind="model" testId="ai-by-model" state={state} />
          <div className="grid gap-4 2xl:grid-cols-2">
            <BreakdownTable title={t("breakdown.byProvider")} rows={view.byProvider} kind="provider" testId="ai-by-provider" state={state} />
            <BreakdownTable title={t("breakdown.byTask")} rows={view.byTask} kind="task" testId="ai-by-task" state={state} />
          </div>
          <CallLog calls={data.calls} total={data.totalCalls} page={data.page} pageSize={data.pageSize} timeZone={data.timeZone} state={state} exportHref={data.exportHref} csvMaxRows={data.csvMaxRows} modelLabels={data.modelLabels} />
          <footer className="text-ink-2 text-data flex flex-col gap-1" data-testid="ai-usage-notes">
            <p>{t("notes.prices")}</p>
            {totals.legacy > 0 ? <p data-testid="ai-note-legacy">{t("notes.legacy", { count: format.number(totals.legacy) })}</p> : null}
            {missing !== "" ? <p data-testid="ai-note-missing">{t("notes.missing", { models: missing })}</p> : null}
          </footer>
        </>
      )}
    </div>
  );
}
