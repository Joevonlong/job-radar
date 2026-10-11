import { useTranslations } from "next-intl";

import type { JobRank } from "@/lib/db/queries/types";
import { formatRank, SCORE_TEXT_CLASS, scoreTone } from "@/lib/dashboard/score";
import { cn } from "@/lib/utils";

interface RankValueProps {
  rank: JobRank | null;
  /** `row`: list row; `box`: the big number of the detail page. */
  size?: "row" | "box";
}

/**
 * The rank value (match score + signal bonus) with its colour band, and the "= match + bonus"
 * breakdown under it. Before the AI has scored a job there is no number: it says so instead of
 * showing a fake one. A score made under an older profile or prompt is marked as outdated.
 */
export function RankValue({ rank, size = "row" }: RankValueProps) {
  const t = useTranslations("dashboard.rank");
  const big = size === "box";
  const numberClass = cn("font-mono leading-none font-medium tabular-nums", big ? "text-[40px]" : "text-xl");

  // A job that passed the hard filter but has no AI score yet (no row at all, or a row waiting for the AI)
  // is waiting, not "not ranked" and never outdated.
  if (rank === null || (rank.filterResult === "passed" && rank.rankValue === null)) {
    return (
      <div className="flex flex-col gap-1 pt-px" data-rank="pending">
        <span className={cn(numberClass, "text-muted-foreground")} aria-hidden>
          —
        </span>
        <span className="text-muted-foreground text-xs leading-tight">{t("pending")}</span>
      </div>
    );
  }
  if (rank.filterResult === "filtered_out" || rank.rankValue === null) {
    return (
      <div className="flex flex-col gap-1 pt-px" data-rank="not-ranked">
        <span className={cn(numberClass, "text-score-low-text")} aria-hidden>
          —
        </span>
        <span className="text-muted-foreground text-xs leading-tight">{t("notRanked")}</span>
      </div>
    );
  }

  const tone = scoreTone(rank.rankValue);
  return (
    <div className="flex flex-col gap-1 pt-px" data-rank={tone}>
      <span className={cn(numberClass, SCORE_TEXT_CLASS[tone])} aria-label={t("valueLabel", { value: formatRank(rank.rankValue) })}>
        {formatRank(rank.rankValue)}
      </span>
      {rank.score !== null && !big ? (
        <span className="text-muted-foreground font-mono text-xs leading-tight whitespace-nowrap tabular-nums">
          {t("breakdown", { match: formatRank(rank.score), bonus: formatRank(rank.signalBonus) })}
        </span>
      ) : null}
      {rank.stale && rank.score !== null && !big ? (
        <span className="text-muted-foreground text-xs leading-tight" title={t("staleHint")} data-testid="rank-stale">
          {t("stale")}
        </span>
      ) : null}
    </div>
  );
}
