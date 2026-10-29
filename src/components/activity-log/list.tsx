import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AutoRefresh } from "@/components/sources/auto-refresh";
import { Banner } from "@/components/sources/banner";
import { resolveLocale } from "@/i18n/locale";
import type { ActivityListData } from "@/lib/activity/load";
import { formatDuration, formatFullTime } from "@/lib/format/time";
import { formatInteger } from "@/lib/format/numbers";
import { DeleteDialog } from "./delete-dialog";
import { Dropped, Progress, StatusBadge, Pagination, panel, field, link, rootName } from "./shared";

export function ActivityList({ data }: { data: ActivityListData }) {
  const t = useTranslations("activityLog");
  const locale = resolveLocale(useLocale());
  const { url, config } = data;
  return <>
    <AutoRefresh active={data.anyActive} intervalMs={config.ui.refresh_seconds * 1000} />
    {!config.enabled ? <Banner tone="warn">{t("banners.off")}</Banner> : null}
    <form action="/sources/logs" method="get" className={`${panel} flex flex-wrap items-end gap-sp-3`} data-testid="activity-log-filters">
      <label className="grid gap-sp-1 text-label">{t("filters.type")}<select name="type" defaultValue={url.type} className={field} data-testid="activity-log-filter-type">{(["all", "cycle", "request", "system"] as const).map((value) => <option key={value} value={value}>{t(`filters.types.${value}`)}</option>)}</select></label>
      <label className="grid gap-sp-1 text-label">{t("filters.status")}<select name="status" defaultValue={url.status} className={field} data-testid="activity-log-filter-status">{(["all", "active", "failed", "partial"] as const).map((value) => <option key={value} value={value}>{t(`filters.statuses.${value}`)}</option>)}</select></label>
      <label className="grid gap-sp-1 text-label">{t("filters.range")}<select name="range" defaultValue={url.range ?? ""} className={field} data-testid="activity-log-filter-range"><option value="">{t("filters.defaultRange", { days: formatInteger(config.ui.default_range_days, locale) })}</option>{(["today", "7d", "30d", "custom"] as const).map((value) => <option key={value} value={value}>{t(`filters.ranges.${value}`)}</option>)}</select></label>
      <label className="grid min-w-0 gap-sp-1 text-label">{t("filters.from")}<Input type="date" name="from" defaultValue={url.from ?? data.range.from} data-testid="activity-log-filter-from" /></label>
      <label className="grid min-w-0 gap-sp-1 text-label">{t("filters.to")}<Input type="date" name="to" defaultValue={url.to ?? data.range.to} data-testid="activity-log-filter-to" /></label>
      <label className="flex max-w-full items-center gap-sp-2 text-body-sm"><input type="checkbox" name="issues" value="1" defaultChecked={url.issues === "1"} data-testid="activity-log-filter-issues" />{t("filters.issues")}</label>
      <Button type="submit" size="sm" data-testid="activity-log-filter-apply">{t("filters.apply")}</Button>
    </form>
    <div className="flex flex-wrap justify-end gap-sp-2"><DeleteDialog scope="range" today={data.today} /><DeleteDialog scope="all" today={data.today} /></div>
    {data.rows.length === 0 ? <p className={panel} data-testid="activity-log-empty">{t("empty")}</p> : <ol className="grid min-w-0 gap-sp-3" aria-label={t("entries")} data-testid="activity-log-list">
      {data.rows.map((root) => <li key={root.id} className={`${panel} grid gap-sp-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)]`} data-testid="activity-log-row" data-activity-log-root-id={root.id} data-activity-log-active={root.active} data-activity-log-scope={root.scope}>
        <div className="grid min-w-0 content-start gap-sp-1"><time dateTime={root.startedAt.toISOString()} className="font-mono text-data text-ink-2">{formatFullTime(root.startedAt, { locale, timeZone: data.timeZone })}</time><Link className={`${link} text-title-sm font-bold`} href={`/sources/logs/${root.id}`} data-testid="activity-log-entry">{rootName(root, t, formatInteger(root.cycleId, locale))}</Link><Dropped count={root.eventsDropped} /></div>
        <div className="grid content-start gap-sp-2"><StatusBadge value={root.display} /><span className="font-mono text-data">{t("duration")}: {formatDuration(root.durationMs, locale)}</span><span className="text-data-sm">{t("issuesCount", { warnings: formatInteger(root.warnEvents, locale), errors: formatInteger(root.errorEvents, locale) })}</span></div>
        <div className="grid min-w-0 content-start gap-sp-2">{root.currentStep ? <Progress name={root.currentStep.name} done={root.currentStep.progressDone} total={root.currentStep.progressTotal} /> : <Progress done={root.progressDone} total={root.progressTotal} />}{root.currentSubtask ? <Progress name={root.currentSubtask.name} done={root.currentSubtask.progressDone} total={root.currentSubtask.progressTotal} /> : null}</div>
      </li>)}
    </ol>}
    <Pagination state={url} total={data.total} pageSize={config.ui.page_size} />
  </>;
}
