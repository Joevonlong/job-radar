import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { PercentBar, Stacked100 } from "@/components/viz";
import { Card } from "@/components/ui/card";
import { COMPACT_OPTIONS, formatPercent, isCompact } from "@/lib/format/numbers";
import type { AiUsageTotals } from "@/lib/ai-usage/view";
import { cn } from "@/lib/utils";

import { Unknown, Usd } from "./usage-cells";

function Tile({ label, testId, value, hero = false, className, children, hint, note }: { label: string; testId: string; value: number | null; hero?: boolean; className?: string; children: ReactNode; hint: string; note?: ReactNode }) {
  return (
    <Card className={cn("min-w-0 gap-1.5 px-4 py-3", hero && "bg-hi text-hi-ink", className)} data-testid={testId} {...(value !== null ? { "data-value": value } : { "data-unknown": "true" })}>
      <h2 className={cn("font-mono text-data font-semibold tracking-[0.04em]", hero ? "text-hi-ink" : "text-ink-2")}>{label}</h2>
      <p className={cn("font-display tabular-nums", "text-num-l")}>{children}</p>
      <p className={cn("text-data leading-snug", hero ? "text-hi-ink" : "text-ink-2")}>{hint}</p>
      {note}
    </Card>
  );
}

const note = "border-ink-3 rounded-tag text-data-sm w-fit max-w-full border-[1.5px] border-dashed px-1.5 leading-snug";

/**
 * The five headline numbers: equivalent API cost (hero), actual spend, savings, calls, tokens. An unknown total is
 * the dashed "unknown", never a 0; what was left out of a total is counted under it.
 */
export function KpiTiles({ totals }: { totals: AiUsageTotals }) {
  const t = useTranslations("aiUsage.kpi");
  const tOutcome = useTranslations("aiUsage.outcome");
  const format = useFormatter();
  const int = (n: number) => format.number(n);
  // headline figures: 7+ digits are compact (`1.95M`) so they never outgrow the card; the exact count is in the title
  const big = (n: number) => (isCompact(n) ? <span title={int(n)} data-compact="true">{format.number(n, COMPACT_OPTIONS)}</span> : <span>{int(n)}</span>);
  const allEquivalentUnknown = totals.equivalentUnknownCalls >= totals.calls;
  const equivalent = allEquivalentUnknown ? null : totals.equivalentUsd;
  const share = equivalent !== null && equivalent > 0 ? (totals.actualUsd / equivalent) * 100 : null;
  const savings = allEquivalentUnknown ? null : totals.savingsUsd;
  const actual = totals.actualUnknownCalls >= totals.calls ? null : totals.actualUsd;
  const tokens = totals.tokenCalls === 0 ? null : totals.tokensIn + totals.tokensOut;
  // a sub-count that old rows never recorded is "unknown", not 0: the known sum, plus how many calls are missing from it
  const part = (sum: number, unknownCalls: number) =>
    unknownCalls <= 0 ? int(sum) : unknownCalls >= totals.tokenCalls ? t("partAllUnknown") : t("partSome", { sum: int(sum), count: int(unknownCalls) });
  return (
    <section aria-label={t("label")} className="grid grid-cols-2 gap-4 md:grid-cols-6 xl:grid-cols-5" data-testid="ai-usage-kpis">
      <Tile label={t("equivalent")} testId="ai-kpi-equivalent" value={equivalent} hero className="col-span-2 md:col-span-2 xl:col-span-1" hint={t("equivalentHint")}
        note={totals.equivalentUnknownCalls > 0 && !allEquivalentUnknown ? (
          <>
            {totals.equivalentUnknownCalls - totals.equivalentUnknownModelCalls > 0 ? <p className={cn(note, "text-hi-ink")} data-testid="ai-kpi-missing-equivalent" data-count={totals.equivalentUnknownCalls - totals.equivalentUnknownModelCalls}>{t("missingEquivalent", { count: totals.equivalentUnknownCalls - totals.equivalentUnknownModelCalls })}</p> : null}
            {totals.equivalentUnknownModelCalls > 0 ? <p className={cn(note, "text-hi-ink")} data-testid="ai-kpi-unknown-model" data-count={totals.equivalentUnknownModelCalls}>{t("unknownModelCalls", { count: totals.equivalentUnknownModelCalls })}</p> : null}
          </>
        ) : null}>
        <Usd value={equivalent} compact />
      </Tile>
      <Tile label={t("actual")} testId="ai-kpi-actual" value={actual} className="md:col-span-2 xl:col-span-1" hint={t("actualHint")}
        note={
          share !== null ? (
            <span className="flex items-center gap-2">
              <PercentBar value={share} size="sm" label={false} ariaLabel={t("actualBar")} className="min-w-0 flex-1" />
              <span className="text-data font-mono whitespace-nowrap">{t("actualShare", { percent: formatPercent(share) })}</span>
            </span>
          ) : null
        }>
        <Usd value={actual} compact />
      </Tile>
      <Tile label={t("savings")} testId="ai-kpi-savings" value={savings} className="md:col-span-2 xl:col-span-1" hint={savings === null ? t("savingsNone") : t("savingsHint")}>
        <Usd value={savings} compact />
      </Tile>
      <Tile label={t("calls")} testId="ai-kpi-calls" value={totals.calls} className="md:col-span-3 xl:col-span-1" hint={t("callsHint")}
        note={
          <>
            <p className="text-data font-mono leading-snug">{t("callsSplit", { ok: int(totals.ok), invalid: int(totals.invalid), failed: int(totals.failed), legacy: int(totals.legacy) })}</p>
            <Stacked100
              parts={[
                { key: "ok", label: tOutcome("okShort"), value: totals.ok, tone: "good" },
                { key: "invalid", label: tOutcome("invalidShort"), value: totals.invalid, tone: "warn" },
                { key: "failed", label: tOutcome("failedShort"), value: totals.failed, tone: "bad" },
                { key: "legacy", label: tOutcome("legacyShort"), value: totals.legacy, tone: "ink" },
              ]}
            />
          </>
        }>
        {big(totals.calls)}
      </Tile>
      <Tile label={t("tokens")} testId="ai-kpi-tokens" value={tokens} className="col-span-2 md:col-span-3 xl:col-span-1" hint={tokens === null ? t("tokensHint") : t("tokensSplit", { in: int(totals.tokensIn), cached: part(totals.tokensInCached, totals.cachedUnknownCalls), out: int(totals.tokensOut), reasoning: part(totals.tokensOutReasoning, totals.reasoningUnknownCalls) })}
        note={totals.tokenUnknownCalls > 0 ? <p className={note} data-testid="ai-kpi-unknown-tokens" data-count={totals.tokenUnknownCalls}>{t("unknownTokens", { count: totals.tokenUnknownCalls })}</p> : null}>
        {tokens === null ? <Unknown /> : big(tokens)}
      </Tile>
    </section>
  );
}
