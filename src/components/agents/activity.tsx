import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { resolveLocale, type Locale } from "@/i18n/locale";
import { activityHref, type AgentActivityData, type AgentActivityRow } from "@/lib/agent-access/activity";
import { formatInteger } from "@/lib/format/numbers";
import { formatFullTime, formatRelativeTime } from "@/lib/format/time";
import { AGENTS_PAGE } from "@/lib/settings/tabs";

type Translator = ReturnType<typeof useTranslations<"agents.activity">>;

const OUTCOME_BADGE: Record<string, "status-good" | "status-warn" | "status" | "gate-bad"> = {
  ok: "status-good",
  not_permitted: "status-warn",
  invalid_input: "status",
  error: "gate-bad",
};
const OUTCOME_FILL: Record<string, string> = { ok: "bg-good", not_permitted: "bg-warn", invalid_input: "bg-soft", error: "bg-bad" };

function areaOf(permission: string): string {
  if (permission === "actions:run") return "actions";
  if (permission === "jobs:import") return "import";
  return permission.split(":")[0] ?? permission;
}

const KNOWN_OUTCOMES = ["ok", "not_permitted", "invalid_input", "error"] as const;
const DATA_AREAS = ["jobs", "raw", "tracking", "notes", "match", "profile", "career", "writer", "replies", "ops", "config"] as const;

function outcomeLabel(t: Translator, outcome: string): string {
  const known = KNOWN_OUTCOMES.find((candidate) => candidate === outcome);
  return known === undefined ? outcome : t(`result.${known}`);
}

function FilterBar({ data }: { data: AgentActivityData }) {
  const t = useTranslations("agents.activity");
  const tAreas = useTranslations("agents.matrix.areas");
  const { query } = data;
  const groups = new Map<string, string[]>();
  for (const tool of data.tools) groups.set(areaOf(tool.permission), [...(groups.get(areaOf(tool.permission)) ?? []), tool.id]);
  const areaName = (area: string) => {
    if (area === "actions" || area === "import") return t(`area.${area}`);
    const known = DATA_AREAS.find((candidate) => candidate === area);
    return known === undefined ? area : tAreas(`${known}.name`);
  };
  const known = new Set(data.tools.map((tool) => tool.id));
  const label = "flex min-w-0 flex-col gap-1 text-label font-bold text-ink-2";
  return (
    <form method="get" action="/settings/agents/activity" role="search" aria-label={t("filtersLabel")} className="flex flex-wrap items-end gap-3" data-testid="agents-activity-filters">
      <label className={label}>
        {t("filters.connection.label")}
        <NativeSelect name="connection" defaultValue={query.connection === undefined ? "" : String(query.connection)} data-testid="agents-activity-filter-connection">
          <option value="">{t("filters.connection.all")}</option>
          <option value="stdio">{t("filters.connection.stdio")}</option>
          {data.connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.revoked ? t("filters.connection.revoked", { name: connection.name }) : connection.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className={label}>
        {t("filters.tool.label")}
        <NativeSelect name="tool" defaultValue={query.tool ?? ""} data-testid="agents-activity-filter-tool">
          <option value="">{t("filters.tool.all")}</option>
          {[...groups].map(([area, ids]) => (
            <optgroup key={area} label={areaName(area)}>
              {ids.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </optgroup>
          ))}
          {query.tool !== undefined && !known.has(query.tool) ? <option value={query.tool}>{query.tool}</option> : null}
        </NativeSelect>
      </label>
      <label className={label}>
        {t("filters.result.label")}
        <NativeSelect name="result" defaultValue={query.result ?? ""} data-testid="agents-activity-filter-result">
          <option value="">{t("filters.result.all")}</option>
          {data.outcomes.map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcomeLabel(t, outcome)}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className={label}>
        {t("filters.range.label")}
        <NativeSelect name="range" defaultValue={data.range} data-testid="agents-activity-filter-range">
          {(["today", "7d", "30d", "all"] as const).map((range) => (
            <option key={range} value={range}>
              {t(`filters.range.${range}`)}
            </option>
          ))}
        </NativeSelect>
      </label>
      <Button type="submit" size="sm" data-testid="agents-activity-apply">
        {t("filters.apply")}
      </Button>
      <Link href="/settings/agents/activity" className="text-body-sm underline decoration-dotted underline-offset-4" data-testid="agents-activity-clear">
        {t("filters.clear")}
      </Link>
    </form>
  );
}

function SummaryBar({ data, locale }: { data: AgentActivityData; locale: Locale }) {
  const t = useTranslations("agents.activity");
  const { total, byOutcome } = data.summary;
  const entries = Object.entries(byOutcome).filter(([, count]) => count > 0);
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={t("summary.bar")} data-testid="agents-activity-summary">
      <p className="font-mono text-data font-bold" data-testid="agents-activity-total">
        {t("summary.total", { count: total })}
      </p>
      {total > 0 ? (
        <>
          <div className="flex h-3 w-full overflow-hidden rounded-pill border-bw border-border bg-card" role="img" aria-label={t("summary.bar")}>
            {entries.map(([outcome, count]) => (
              <span key={outcome} className={`${OUTCOME_FILL[outcome] ?? "bg-ink-3"} h-full`} style={{ width: `${(count / total) * 100}%` }} data-outcome={outcome} />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm">
            {entries.map(([outcome, count]) => (
              <li key={outcome} className="flex items-center gap-1.5" data-testid="agents-activity-legend" data-outcome={outcome}>
                <span aria-hidden className={`${OUTCOME_FILL[outcome] ?? "bg-ink-3"} size-3 rounded-tag border-bw border-border`} />
                {t("summary.segment", { result: outcomeLabel(t, outcome), count: formatInteger(count, locale) })}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function ConnectionCell({ row }: { row: AgentActivityRow }) {
  const t = useTranslations("agents.activity.connection");
  const { connection } = row;
  if (connection.kind === "stdio") return <span>{t("stdio")}</span>;
  const name = connection.name ?? t("unknownToken", { id: connection.tokenId ?? 0 });
  return connection.revoked ? (
    <span className="flex flex-wrap items-center gap-1.5 text-ink-3">
      <span>{name}</span>
      <Badge variant="skill-miss">{t("revoked")}</Badge>
    </span>
  ) : (
    <span>{name}</span>
  );
}

function ToolCell({ row }: { row: AgentActivityRow }) {
  const t = useTranslations("agents.activity.kind");
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <code className="font-mono text-data [overflow-wrap:anywhere]">{row.tool}</code>
      {row.toolKind === null ? null : <Badge variant="tag">{t(row.toolKind)}</Badge>}
    </span>
  );
}

function TargetCell({ row }: { row: AgentActivityRow }) {
  const t = useTranslations("agents.activity.target");
  const { target } = row;
  if (target === null) return <span className="text-ink-3">—</span>;
  const kind = target.type === "job" ? null : <span className="text-label text-ink-3">{t(target.type)} </span>;
  if (target.jobId !== null && target.title !== null) {
    return (
      <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="agents-activity-target">
        {kind}
        <Link href={`/jobs/${target.jobId}`} className="underline decoration-dotted underline-offset-4">
          {target.company === null ? target.title : `${target.title} · ${target.company}`}
        </Link>
      </span>
    );
  }
  return (
    <span className="font-mono text-data text-ink-2" data-testid="agents-activity-target">
      {kind}
      {t("unresolved", { id: target.id })}
    </span>
  );
}

function ResultCell({ row }: { row: AgentActivityRow }) {
  const t = useTranslations("agents.activity");
  const label = outcomeLabel(t, row.outcome);
  return <Badge variant={OUTCOME_BADGE[row.outcome] ?? "status"} data-testid="agents-activity-result" data-outcome={row.outcome}>{row.errorCategory === null ? label : t("errorWith", { result: label, category: row.errorCategory })}</Badge>;
}

function UndoCell({ row }: { row: AgentActivityRow }) {
  const t = useTranslations("agents.activity.undo");
  return row.undo === null ? null : (
    <Badge variant="skill" data-testid="agents-activity-undo" data-state={row.undo.state}>
      {t(row.undo.state)}
    </Badge>
  );
}

function TimeCell({ row, now, locale, timeZone }: { row: AgentActivityRow; now: string; locale: Locale; timeZone: string }) {
  return (
    <time dateTime={row.calledAt} title={formatFullTime(row.calledAt, { locale, timeZone })} className="whitespace-nowrap font-mono text-data">
      {formatRelativeTime(row.calledAt, new Date(now), { locale, timeZone })}
    </time>
  );
}

function Rows({ data, now, locale }: { data: AgentActivityData; now: string; locale: Locale }) {
  const t = useTranslations("agents.activity");
  const th = "px-3 py-2 text-left text-label font-bold text-ink-3";
  const td = "px-3 py-2 align-top text-body-sm";
  return (
    <>
      <div className="hidden min-w-0 overflow-x-auto rounded-card border-bw border-border bg-card md:block">
        <table className="w-full min-w-[56rem] border-collapse" data-testid="agents-activity-table" aria-label={t("list")}>
          <thead>
            <tr className="border-b-bw border-border">
              <th scope="col" className={th}>{t("columns.time")}</th>
              <th scope="col" className={th}>{t("columns.connection")}</th>
              <th scope="col" className={th}>{t("columns.tool")}</th>
              <th scope="col" className={th}>{t("columns.target")}</th>
              <th scope="col" className={th}>{t("columns.result")}</th>
              <th scope="col" className={`${th} text-right`}>{t("columns.returned")}</th>
              <th scope="col" className={`${th} text-right`}>{t("columns.duration")}</th>
              <th scope="col" className={th}><span className="sr-only">{t("columns.undo")}</span></th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.id} className="border-b-bw border-border last:border-b-0" data-testid="agents-activity-row" data-call-id={row.id}>
                <td className={td}><TimeCell row={row} now={now} locale={locale} timeZone={data.timeZone} /></td>
                <td className={td}><ConnectionCell row={row} /></td>
                <td className={td}><ToolCell row={row} /></td>
                <td className={td}><TargetCell row={row} /></td>
                <td className={td}><ResultCell row={row} /></td>
                <td className={`${td} text-right font-mono`}>{formatInteger(row.returnedCount, locale)}</td>
                <td className={`${td} whitespace-nowrap text-right font-mono`}>{t("duration", { ms: formatInteger(row.durationMs, locale) })}</td>
                <td className={td}><UndoCell row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex min-w-0 flex-col gap-3 md:hidden" aria-label={t("list")} data-testid="agents-activity-cards">
        {data.rows.map((row) => (
          <li key={row.id} className="flex min-w-0 flex-col gap-2 rounded-cell border-bw border-border bg-card px-3 py-3" data-testid="agents-activity-card" data-call-id={row.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TimeCell row={row} now={now} locale={locale} timeZone={data.timeZone} />
              <ResultCell row={row} />
            </div>
            <ToolCell row={row} />
            <TargetCell row={row} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-body-sm">
              <ConnectionCell row={row} />
              <span className="font-mono text-data">
                {formatInteger(row.returnedCount, locale)} · {t("duration", { ms: formatInteger(row.durationMs, locale) })}
              </span>
            </div>
            <UndoCell row={row} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Empty({ data }: { data: AgentActivityData }) {
  const t = useTranslations("agents.activity.empty");
  const filtered = data.anyCalls;
  return (
    <Card data-testid={filtered ? "agents-activity-empty-filtered" : "agents-activity-empty"}>
      <CardContent className="flex flex-col items-start gap-3">
        <p className="font-bold">{filtered ? t("filtered.title") : t("none.title")}</p>
        {filtered ? null : <p className="text-body-sm text-ink-2">{t("none.body")}</p>}
        <Link href={filtered ? "/settings/agents/activity" : AGENTS_PAGE} className="text-body-sm underline decoration-dotted underline-offset-4">
          {filtered ? t("filtered.clear") : t("none.link")}
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * The agent activity page body: the URL-driven filter bar, the count and per-result bar of the filtered calls, the table (cards on a
 * phone) newest first with an "older" link that keeps the filters, and the two empty states. The last column is filled only when an undo
 * loader is registered.
 */
export function AgentActivity({ data, now }: { data: AgentActivityData; now: string }) {
  const t = useTranslations("agents.activity");
  const locale = resolveLocale(useLocale());
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="agents-activity-page">
      {data.retentionDays === null ? null : <p className="text-body-sm text-ink-2">{t("retention", { days: data.retentionDays })}</p>}
      <FilterBar data={data} />
      <SummaryBar data={data} locale={locale} />
      {data.rows.length === 0 ? <Empty data={data} /> : <Rows data={data} now={now} locale={locale} />}
      {data.query.before !== undefined || data.nextBefore !== null ? (
        <div className="flex flex-wrap gap-3">
          {data.query.before !== undefined ? (
            <Button asChild variant="outline" size="sm">
              <Link href={activityHref({ ...data.query, before: undefined })} data-testid="agents-activity-newest">{t("newest")}</Link>
            </Button>
          ) : null}
          {data.nextBefore !== null ? (
            <Button asChild variant="outline" size="sm">
              <Link href={activityHref(data.query, { before: data.nextBefore })} data-testid="agents-activity-older">{t("older")}</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
