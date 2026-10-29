import Link from "next/link";
import type { ReactNode } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { PageHeader } from "@/components/shell/page-header";
import { SourcesSubnav } from "@/components/sources/subnav";
import { AutoRefresh } from "@/components/sources/auto-refresh";
import { Banner } from "@/components/sources/banner";
import { Button } from "@/components/ui/button";
import { resolveLocale } from "@/i18n/locale";
import type { ActivityDetailData } from "@/lib/activity/load";
import { activityLabel } from "@/lib/activity/messages";
import { queryLabel } from "@/lib/activity/query-labels";
import { DELIVERY_DISPOSITIONS } from "@/lib/channels/delivery";
import { formatInteger, formatUsdAmount } from "@/lib/format/numbers";
import { formatDuration, formatFullTime } from "@/lib/format/time";
import { DeleteDialog } from "./delete-dialog";
import { EventParams } from "./event-params";
import { Dropped, Progress, StatusBadge, Pagination, panel, field, link, cell, rootName } from "./shared";

export function ActivityDetail({ data }: { data: ActivityDetailData }) {
  const t = useTranslations("activityLog");
  const page = useTranslations("pages.logs");
  const locale = resolveLocale(useLocale());
  const format = useFormatter();
  const time = (date: Date | null) => date ? formatFullTime(date, { locale, timeZone: data.timeZone }) : t("unknown");
  const count = (value: number | null | undefined) => value === null || value === undefined ? t("unknown") : formatInteger(value, locale);
  const { root, config } = data;
  const name = rootName(root, t, count(root.cycleId));
  const rootSpan = data.spans.find((span) => span.id === root.id);
  const rootSpans = data.spans.filter((span) => span.id !== root.id);
  const children = new Map<string, typeof rootSpans>();
  const ids = new Set(data.spans.map((span) => span.id));
  for (const span of rootSpans) {
    const parent = span.parentId && ids.has(span.parentId) ? span.parentId : root.id;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  // A corrupt legacy parent cycle cannot recurse forever or leak an orphaned branch out of the tree.
  const seen = new Set<string>();
  const tree = (parent: string): ReactNode => (children.get(parent) ?? []).map((span) => {
    if (seen.has(span.id)) return null;
    seen.add(span.id);
    const summary = data.stepDurations?.find((duration) => duration.name === span.name);
    return <li key={span.id} className="min-w-0 border-l-bw border-grid pl-sp-3" data-testid="activity-log-step" data-activity-log-span-name={span.name}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-sp-2"><b>{activityLabel(t, "span", span.name)}</b><StatusBadge value={span.display} /><span className="font-mono text-data">{formatDuration(summary ? summary.durationMs : span.durationMs, locale)}</span></div>
      <Progress done={span.progressDone} total={span.progressTotal} />
      {span.reasonCode ? <p className="text-body-sm">{activityLabel(t, "reason", span.reasonCode)}</p> : null}
      <Dropped count={span.eventsDropped} />
      {span.jobId !== null ? <p className="text-body-sm">{span.jobExists ? <Link prefetch={false} className={link} href={`/jobs/${span.jobId}`} data-testid="activity-log-span-job">{t("viewJob")}</Link> : t("jobGone")}</p> : null}
      <ul className="mt-sp-2 grid min-w-0 gap-sp-3">{tree(span.id)}</ul>
    </li>;
  });
  const columns = ["query", "channel", "status", "reason", "fetched", "new", "cost", "delivered", "billed", "stored", "dispositions"] as const;
  return <>
    <PageHeader title={page("detailTitle")} description={name} actions={<DeleteDialog scope="root" rootId={root.id} today={data.today} />} />
    <SourcesSubnav current="logs" />
    <AutoRefresh active={root.active} intervalMs={config.ui.refresh_seconds * 1000} />
    {!config.enabled ? <Banner tone="warn">{t("banners.off")}</Banner> : null}
    <Link className={link} href="/sources/logs">{t("back")}</Link>
    <section className={`${panel} grid gap-sp-3`} aria-label={t("summary")}>
      <h2 className="text-h2 font-display">{name}</h2><StatusBadge value={data.display} />
      <dl className="grid gap-sp-2 text-body-sm sm:grid-cols-3">{([["started", time(root.startedAt)], ["finished", time(root.finishedAt)], ["duration", formatDuration(root.durationMs, locale)]] as const).map(([key, value]) => <div key={key}><dt className="text-ink-2">{t(key)}</dt><dd className="font-mono text-data">{value}</dd></div>)}</dl>
      <Progress done={root.progressDone} total={root.progressTotal} />{root.reasonCode || root.request?.errorCode ? <p>{activityLabel(t, "reason", root.reasonCode ?? root.request?.errorCode ?? null)}</p> : null}<Dropped count={root.eventsDropped} />
      {rootSpan?.jobId !== null && rootSpan?.jobId !== undefined ? <p>{rootSpan.jobExists ? <Link prefetch={false} className={link} href={`/jobs/${rootSpan.jobId}`} data-testid="activity-log-root-job">{t("viewJob")}</Link> : t("jobGone")}</p> : null}
      <Link className={link} href={data.aiUsageHref} data-testid="activity-log-ai-usage">{t("aiUsage")}</Link>
    </section>
    <section className={`${panel} grid gap-sp-3`} aria-labelledby="activity-log-tree-title"><h2 id="activity-log-tree-title" className="text-h2 font-display">{t("steps")}</h2><ul className="grid min-w-0 gap-sp-3" data-testid="activity-log-tree">{tree(root.id)}</ul>{rootSpans.length === 0 ? <p>{t("noSteps")}</p> : null}</section>
    {data.attempts.length ? <section className={`${panel} grid gap-sp-3`} aria-labelledby="activity-log-attempts-title"><h2 id="activity-log-attempts-title" className="text-h2 font-display">{t("attempts")}</h2><ol className="grid gap-sp-3" data-testid="activity-log-attempts">{data.attempts.map((attempt) => {
      const current = attempt.requestCurrent ?? undefined;
      const code = attempt.status === "interrupted" && current === "pending" ? "requeued" : attempt.status;
      return <li key={attempt.id} className="flex flex-wrap items-baseline gap-sp-3" data-testid="activity-log-attempt"><Link className={link} href={`/sources/logs/${attempt.rootId}`}>{time(attempt.startedAt)}</Link><StatusBadge value={{ code: code === "unknown" ? "unknown" : code, possiblyInterrupted: false, ...(current ? { requestCurrent: current } : {}) }} /></li>;
    })}</ol></section> : null}
    <section className={`${panel} grid gap-sp-3`} aria-labelledby="activity-log-queries-title"><h2 id="activity-log-queries-title" className="text-h2 font-display">{t("queries")}</h2>
      {data.queries.rows.length ? <div role="region" tabIndex={0} aria-label={t("queries")} className="min-w-0 overflow-x-auto"><table className="w-full text-body-sm" data-testid="activity-log-queries"><thead className="bg-soft text-cap-style"><tr>{columns.map((column) => <th scope="col" key={column} className={cell}>{t(`columns.${column}`)}</th>)}</tr></thead><tbody>{data.queries.rows.map((query) => <tr key={query.spanId} className="border-b border-grid" data-testid="activity-log-query" data-activity-log-has-run={query.run !== null}>
        <th scope="row" className={cell}>{queryLabel(data.queryLabels, query.queryId, t)}</th>
        <td className={cell}>{query.channelId ? <Link prefetch={false} className={link} href="/sources">{query.channelId}</Link> : t("unknown")}</td>
        <td className={cell}>{activityLabel(t, "spanStatus", query.status)}{query.run ? <div>{t("runStatusLabel")}: {activityLabel(t, "runStatus", query.run.status)}</div> : null}</td>
        <td className={cell}>{query.reasonCode ? activityLabel(t, "reason", query.reasonCode) : query.run?.errorCode ? activityLabel(t, "error", query.run.errorCode) : t("notRecorded")}{query.cascadeReasons ? <ul>{Object.entries(query.cascadeReasons).map(([channel, reason]) => <li key={channel}>{channel}: {activityLabel(t, "reason", reason)}</li>)}</ul> : null}</td>
        <td className={cell}>{count(query.run?.fetched)}</td><td className={cell}>{count(query.run?.newCount)}</td><td className={`${cell} whitespace-nowrap`}>{query.run ? formatUsdAmount(format, query.run.costUsd) : t("unknown")}</td>
        {query.delivery ? <><td className={cell}>{count(query.delivery.delivered)}</td><td className={cell}>{count(query.delivery.billedUnits)}</td><td className={cell}>{count(query.delivery.stored)}</td><td className={cell}><ul>{DELIVERY_DISPOSITIONS.filter((code) => query.delivery!.dispositions[code] !== undefined).map((code) => <li key={code}>{activityLabel(t, "disposition", code)}: {count(query.delivery!.dispositions[code])}</li>)}</ul></td></> : <td className={cell} colSpan={4}>{t("notRecorded")}</td>}
      </tr>)}</tbody></table></div> : <p>{t("noQueries")}</p>}
      {data.queries.queriesNotReached !== null ? <p data-testid="activity-log-not-reached">{t("notReached", { count: count(data.queries.queriesNotReached) })}</p> : null}
    </section>
    <section className={`${panel} grid gap-sp-3`} aria-labelledby="activity-log-events-title"><h2 id="activity-log-events-title" className="text-h2 font-display">{t("events")}</h2>
      <form method="get" className="flex flex-wrap items-end gap-sp-2"><label className="grid gap-sp-1 text-label">{t("filters.level")}<select name="level" defaultValue={data.url.level} className={field} data-testid="activity-log-level">{(["all", "info", "warn", "error"] as const).map((level) => <option key={level} value={level}>{t(`level.${level}`)}</option>)}</select></label><Button type="submit" size="sm" data-testid="activity-log-level-apply">{t("filters.apply")}</Button></form>
      {data.events.rows.length ? <div role="region" tabIndex={0} aria-label={t("events")} className="min-w-0 overflow-x-auto"><table className="w-full text-body-sm" data-testid="activity-log-events"><thead className="bg-soft text-cap-style"><tr>{(["time", "level", "event", "details", "job"] as const).map((key) => <th key={key} scope="col" className={cell}>{t(`columns.${key}`)}</th>)}</tr></thead><tbody>{data.events.rows.map((event) => <tr key={event.id} className="border-b border-grid" data-testid="activity-log-event">
        <td className={`${cell} whitespace-nowrap`}>{time(event.at)}</td><td className={cell}>{activityLabel(t, "level", event.level)}</td><td className={cell}>{event.code === "parse_failed" ? t("rawParseFailed") : activityLabel(t, "event", event.code)}</td><td className={cell}><EventParams event={event} /></td><td className={cell}>{event.job?.exists && event.jobId !== null ? <Link prefetch={false} className={link} href={`/jobs/${event.jobId}`} data-testid="activity-log-job">{event.job.title}{event.job.company ? <span className="block text-ink-2">{event.job.company}</span> : null}</Link> : event.job ? <span data-testid="activity-log-missing-job">{t("jobGone")}</span> : t("notApplicable")}</td>
      </tr>)}</tbody></table></div> : <p data-testid="activity-log-no-events">{t("noEvents")}</p>}
      <Pagination state={data.url} total={data.events.total} pageSize={config.ui.events_page_size} base={`/sources/logs/${root.id}`} />
    </section>
  </>;
}
