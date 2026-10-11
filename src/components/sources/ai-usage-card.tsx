import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SourcesView } from "@/lib/sources/view";

import { formatUsd } from "./format";

// `probe`: the "test" button of the AI health card
const TASKS = ["score", "signals", "translate", "summarize", "suggest", "breakdown", "traps", "salary_lookup", "probe"] as const;
const SUBSCRIPTION_PROVIDERS = new Set(["claude-cli", "codex-cli"]);

/** `ai_usage` of this month per provider and task: calls, tokens and the estimated cost. */
export async function AiUsageCard({ ai, month }: { ai: SourcesView["ai"]; month: string }) {
  const [t, format] = await Promise.all([getTranslations("sources.ai"), getFormatter()]);
  return (
    <Card className="gap-0 py-0" data-testid="ai-usage-card">
      <CardHeader className="px-4 py-3">
        <CardTitle className="flex items-baseline justify-between gap-3">
          <h2>{t("title")}</h2>
          <Link href="/sources/ai-usage?range=month" className="text-body-sm font-bold underline underline-offset-4" data-testid="ai-usage-details">
            {t("details")}
          </Link>
        </CardTitle>
        <CardDescription>
          {t("description")} ({month})
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 py-3.5">
        {ai.rows.length === 0 ? (
          <p className="text-ink-2 text-body-sm" data-testid="ai-empty">
            {t("empty")}
          </p>
        ) : (
          <div role="region" tabIndex={0} aria-label={t("title")} className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-cap-style text-ink-2 border-border border-b-bw text-left">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t("col.provider")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t("col.task")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t("col.calls")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t("col.tokens")}
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    {t("col.cost")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ai.rows.map((row) => {
                  const task = TASKS.find((x) => x === row.task);
                  return (
                    <tr key={`${row.provider}-${row.task}`} className="border-grid border-b-[1.5px] last:border-b-0" data-testid="ai-row" data-provider={row.provider} data-task={row.task}>
                      <td className="py-1.5 pr-3 font-mono text-data">{row.provider}</td>
                      <td className="py-1.5 pr-3">{task ? t(`task.${task}`) : row.task}</td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{format.number(row.calls)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono whitespace-nowrap tabular-nums">
                        {format.number(row.tokensIn)} / {format.number(row.tokensOut)}
                      </td>
                      <td className="py-1.5 text-right font-mono whitespace-nowrap tabular-nums" title={SUBSCRIPTION_PROVIDERS.has(row.provider) ? t("subscription") : undefined}>
                        {formatUsd(format, row.costUsd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-border border-t-bw font-semibold">
                  <td className="py-1.5 pr-3" colSpan={4}>
                    {t("total")}
                  </td>
                  <td className="py-1.5 text-right font-mono whitespace-nowrap tabular-nums" data-testid="ai-total">
                    {formatUsd(format, ai.totalCostUsd)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
