import Link from "next/link";
import { useTranslations } from "next-intl";

import { Led } from "@/components/viz";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AI_PROVIDER_KIND, type AiProviderIdChoice } from "@/lib/config/ai-options";
import { aiUsageHref, type AiUsageUrlState } from "@/lib/ai-usage/params";
import { formatLogTime } from "@/lib/ai-usage/time";
import type { AiUsageCall } from "@/lib/db/queries/ai-usage";
import { cn } from "@/lib/utils";

import { taskLabel } from "./labels";
import { Duration, ModelName, Tokens, Usd } from "./usage-cells";

const cell = "py-1.5 pr-3 max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:py-0.5 max-sm:before:text-ink-2 max-sm:before:shrink-0 max-sm:before:content-[attr(data-label)]";
const num = "text-right max-sm:text-right";

/** Actual spend: a subscription call is 0; an API call whose reply had no token counts is unknown (a failed one cost nothing). */
function actualOf(call: AiUsageCall): number | null {
  const api = AI_PROVIDER_KIND[call.provider as AiProviderIdChoice] === "api";
  return api && call.tokensIn === null && call.outcome !== "failed" ? null : call.costUsd;
}

const ERROR_KINDS = ["not_configured", "auth", "rate_limited", "timeout", "network", "provider_error", "invalid_output", "budget"] as const;

function Outcome({ call }: { call: AiUsageCall }) {
  const t = useTranslations("aiUsage");
  if (call.outcome === "ok") return <Led tone="good" label={t("outcome.ok")} />;
  if (call.outcome === "invalid_output") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="border-ink inline-block size-3 shrink-0 rounded-[3px] border-[1.5px]" style={{ backgroundColor: "var(--warn)", backgroundImage: "repeating-linear-gradient(135deg, var(--ink) 0 1.5px, transparent 1.5px 4px)" }} />
        {t("outcome.invalid_output")}
      </span>
    );
  }
  if (call.outcome === "failed") {
    const kind = ERROR_KINDS.find((k) => k === call.errorKind);
    return <Led tone="bad" label={kind ? t(`errorKind.${kind}`) : t("outcome.failed")} />;
  }
  return <span className="text-ink-2">{t("outcome.legacy")}</span>;
}

/** The newest calls first, one row each; pages come from the URL, the CSV export covers the same range and filters. */
export function CallLog({
  calls, total, page, pageSize, timeZone, state, exportHref, csvMaxRows, modelLabels,
}: {
  calls: AiUsageCall[]; total: number; page: number; pageSize: number; timeZone: string; state: AiUsageUrlState; exportHref: string; csvMaxRows: number; modelLabels: Record<string, string>;
}) {
  const t = useTranslations("aiUsage.log");
  const tTask = useTranslations("sources.ai");
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const hasPrev = page > 1;
  const hasNext = last < total;
  return (
    <Card className="min-w-0 gap-0 py-0" data-testid="ai-call-log">
      <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {total > csvMaxRows ? <span className="text-ink-2 text-data">{t("exportCap", { count: new Intl.NumberFormat().format(csvMaxRows) })}</span> : null}
          <Button asChild variant="ghost" size="sm">
            <a href={exportHref} download data-testid="ai-usage-export">
              {t("export")}
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 py-3.5">
        <div role="region" tabIndex={0} aria-label={t("title")} className="overflow-x-auto">
          <table className="w-full text-body-sm max-sm:block" aria-label={t("title")}>
            <thead className="max-sm:sr-only">
              <tr className="text-cap-style text-ink-2 border-border border-b-bw text-left">
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.at")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.task")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.model")}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.input")}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.output")}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.duration")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.outcome")}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.equivalent")}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.actual")}</th>
                <th scope="col" className="py-1.5 font-medium">{t("col.job")}</th>
              </tr>
            </thead>
            <tbody className="max-sm:flex max-sm:flex-col">
              {calls.map((call) => {
                const legacy = call.outcome === null;
                return (
                  <tr
                    key={call.id}
                    className={cn("border-grid border-b-[1.5px] align-top last:border-b-0 max-sm:block max-sm:py-2", legacy && "text-ink-2")}
                    data-testid="ai-call-row"
                    data-outcome={call.outcome ?? "legacy"}
                    data-provider={call.provider}
                    data-task={call.task}
                  >
                    <td className={cn(cell, "font-mono text-data whitespace-nowrap tabular-nums")} data-label={t("col.at")}>{formatLogTime(call.at, timeZone)}</td>
                    <td className={cn(cell, "whitespace-nowrap")} data-label={t("col.task")}>{taskLabel(tTask, call.task)}</td>
                    <td className={cn(cell, "min-w-48 max-sm:min-w-0 max-sm:flex-col max-sm:items-start max-sm:gap-0")} data-label={t("col.model")}>
                      <ModelName provider={call.provider} model={call.model} label={call.model ? (modelLabels[`${call.provider}|${call.model}`] ?? null) : null} source={call.modelSource} />
                    </td>
                    <td className={cn(cell, num)} data-label={t("col.input")} data-testid="ai-call-input">
                      <Tokens main={call.tokensIn} part={call.tokensIn === null ? null : call.tokensInCached} />
                    </td>
                    <td className={cn(cell, num)} data-label={t("col.output")}>
                      <Tokens main={call.tokensOut} part={call.tokensOut === null ? null : call.tokensOutReasoning} />
                    </td>
                    <td className={cn(cell, num)} data-label={t("col.duration")}>
                      <Duration ms={call.durationMs} />
                    </td>
                    <td className={cell} data-label={t("col.outcome")}>
                      <Outcome call={call} />
                    </td>
                    <td className={cn(cell, num)} data-label={t("col.equivalent")}>
                      <Usd value={call.equivalentUsd} />
                    </td>
                    <td className={cn(cell, num)} data-label={t("col.actual")}>
                      <Usd value={actualOf(call)} />
                    </td>
                    <td className={cn(cell, "max-w-56")} data-label={t("col.job")}>
                      {call.job ? (
                        <Link href={`/jobs/${call.job.id}`} className="block max-w-56 truncate underline decoration-dotted underline-offset-4 max-sm:max-w-40" title={call.job.company ? `${call.job.title} · ${call.job.company}` : call.job.title} data-testid="ai-call-job">
                          {call.job.title}
                        </Link>
                      ) : (
                        <span className="text-ink-2">{t("noJob")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <nav aria-label={t("pages")} className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-ink-2 text-data font-mono tabular-nums" data-testid="ai-call-range">{t("range", { from: first, to: last, total })}</span>
          <span className="flex gap-2">
            {hasPrev ? (
              <Button asChild variant="default" size="sm"><Link href={aiUsageHref(state, { page: page - 1 })} rel="prev" data-testid="ai-call-prev">{t("prev")}</Link></Button>
            ) : null}
            {hasNext ? (
              <Button asChild variant="default" size="sm"><Link href={aiUsageHref(state, { page: page + 1 })} rel="next" data-testid="ai-call-next">{t("next")}</Link></Button>
            ) : null}
          </span>
        </nav>
      </CardContent>
    </Card>
  );
}
