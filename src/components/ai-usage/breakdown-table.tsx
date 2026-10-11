import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { PercentBar } from "@/components/viz";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { aiUsageHref, type AiUsageUrlState } from "@/lib/ai-usage/params";
import type { AiUsageBreakdownRow } from "@/lib/ai-usage/view";
import { cn } from "@/lib/utils";

import { taskLabel } from "./labels";
import { Duration, ModelName, Tokens, Unknown, Usd } from "./usage-cells";

export type BreakdownKind = "model" | "provider" | "task";

// the stacked-card look of a phone: every cell names itself (same as the AI health card)
const cell = "py-1.5 pr-3 max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:py-0.5 max-sm:before:text-ink-2 max-sm:before:shrink-0 max-sm:before:content-[attr(data-label)]";
const num = "text-right max-sm:text-right";

/** Calls grouped by model, provider or task, most expensive first; a click on a row filters the whole page by it. */
export function BreakdownTable({ title, rows, kind, testId, state }: { title: string; rows: AiUsageBreakdownRow[]; kind: BreakdownKind; testId: string; state: AiUsageUrlState }) {
  const t = useTranslations("aiUsage.breakdown");
  const tTask = useTranslations("sources.ai");
  const format = useFormatter();
  const colName = t("col.name");
  return (
    <Card className="min-w-0 gap-0 py-0" data-testid={testId}>
      <CardHeader className="px-4 py-3">
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 py-3.5">
        <div role="region" tabIndex={0} aria-label={title} className="overflow-x-auto">
        <table className="w-full text-body-sm max-sm:block" aria-label={title}>
          <thead className="max-sm:sr-only">
            <tr className="text-cap-style text-ink-2 border-border border-b-bw text-left">
              <th scope="col" className="py-1.5 pr-3 font-medium">{colName}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.calls")}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.input")}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.output")}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.duration")}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("col.equivalent")}</th>
              <th scope="col" className="py-1.5 text-right font-medium">{t("col.actual")}</th>
            </tr>
          </thead>
          <tbody className="max-sm:flex max-sm:flex-col">
            {rows.map((row) => {
              const name =
                kind === "model" ? (
                  <ModelName provider={row.provider} model={row.model} label={row.modelLabel} source={row.modelSource} />
                ) : kind === "provider" ? (
                  <span className="font-mono text-data font-bold">{row.key}</span>
                ) : (
                  <span className="font-semibold">{taskLabel(tTask, row.key)}</span>
                );
              const plainName = kind === "model" ? `${row.provider ?? ""} ${row.modelLabel ?? row.model ?? ""}`.trim() : kind === "task" ? taskLabel(tTask, row.key) : row.key;
              const filter = row.filter;
              return (
                <tr
                  key={row.key}
                  className={cn("border-grid relative border-b-[1.5px] align-top last:border-b-0 max-sm:block max-sm:py-2", filter && "hover:bg-soft")}
                  data-testid="ai-breakdown-row"
                  data-key={row.key}
                  data-calls={row.calls}
                  data-equivalent={row.equivalentUsd}
                >
                  <td className={cn(cell, "max-sm:flex-col max-sm:items-start max-sm:gap-0")}>
                    {filter ? (
                      <Link href={aiUsageHref(state, { ...filter, page: null })} className="block after:absolute after:inset-0 after:content-['']" aria-label={t("filterBy", { name: plainName })} data-testid="ai-breakdown-link">
                        {name}
                      </Link>
                    ) : (
                      name
                    )}
                    {row.failed > 0 ? <span className="text-ink-2 text-data-sm font-mono">{t("failedSuffix", { count: format.number(row.failed) })}</span> : null}
                  </td>
                  <td className={cn(cell, num, "font-mono tabular-nums")} data-label={t("col.calls")}>{format.number(row.calls)}</td>
                  <td className={cn(cell, num)} data-label={t("col.input")}>
                    <Tokens main={row.tokenCalls === 0 ? null : row.tokensIn} part={row.tokenCalls === 0 ? null : row.tokensInCached} partUnknown={row.cachedUnknownCalls} partTotal={row.tokenCalls} />
                  </td>
                  <td className={cn(cell, num)} data-label={t("col.output")}>
                    <Tokens main={row.tokenCalls === 0 ? null : row.tokensOut} part={row.tokenCalls === 0 ? null : row.tokensOutReasoning} partUnknown={row.reasoningUnknownCalls} partTotal={row.tokenCalls} />
                  </td>
                  <td className={cn(cell, num)} data-label={t("col.duration")}>
                    <Duration ms={row.avgDurationMs} />
                  </td>
                  <td className={cn(cell, num)} data-label={t("col.equivalent")}>
                    {row.equivalentUnknownCalls >= row.calls ? (
                      <Unknown />
                    ) : (
                      <span className="flex flex-col items-end gap-1">
                        <Usd value={row.equivalentUsd} />
                        <PercentBar value={row.share} size="sm" label={false} ariaLabel={t("col.equivalent")} className="w-24" />
                      </span>
                    )}
                  </td>
                  <td className={cn(cell, num, "pr-0")} data-label={t("col.actual")}>
                    <Usd value={row.actualUnknownCalls >= row.calls ? null : row.actualUsd} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </CardContent>
    </Card>
  );
}
