import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { JobViewTransition } from "@/components/jobs/job-view-transition";
import { ScoreComposition } from "@/components/viz/score-composition";
import { ScoreMeter } from "@/components/viz/score-meter";
import { formatRank } from "@/lib/dashboard/score";
import { scoreMetaText } from "@/lib/dashboard/score-meta";
import { UNKNOWN } from "@/lib/format/numbers";

import { Panel, PanelAside } from "./panel";

export interface ScoreCardProps {
  jobId: number;
  /** Newest score row; null when the job has none yet. */
  score: {
    rankValue: number | null;
    /** AI match score after the German deduction. */
    score: number | null;
    signalBonus: number;
    filterResult: "passed" | "filtered_out";
    stale: boolean;
    aiScore: number | null;
    germanPenalty: number;
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
    scoredAt: Date | null;
  } | null;
  /** `notify.yaml: push_min_score`: the red triangle. */
  pushLine: number;
  /** `interests.yaml: bonus_cap`: the stacked bar spans 100 + this. */
  bonusCap: number;
  /** "Score now" button for a job that waits for its AI score. */
  scoreNow: ReactNode;
  /** When the score was made, already formatted; null when unknown. */
  scoredWhen: string | null;
  /** The market's local language as the page names it (the deduction line). */
  languageName?: string | null;
}

/**
 * "Rank value" card of the detail page: the 20-cell meter with the 72px number, the stacked match + bonus bar, and the
 * numbers behind it. A job the filter removed has no rank value and says so; one waiting for the AI shows the pending state.
 */
export function ScoreCard({ jobId, score, pushLine, bonusCap, scoreNow, scoredWhen, languageName = null }: ScoreCardProps) {
  const t = useTranslations("dashboard.detail");
  const tRank = useTranslations("dashboard.rank");
  const tMeta = useTranslations("scoring.meta");
  const notRanked = score !== null && score.filterResult === "filtered_out";
  const scored = score !== null && score.rankValue !== null && !notRanked;
  const bonus = score === null ? 0 : Math.min(score.signalBonus, bonusCap);
  const meta =
    scored && score
      ? scoreMetaText(
          { provider: score.provider, model: score.model, promptVersion: score.promptVersion, when: scoredWhen },
          { by: (provider) => tMeta("by", { provider }), model: (model) => tMeta("model", { model }), prompt: (version) => tMeta("prompt", { version }) },
        )
      : null;

  return (
    <Panel id="h-rank" title={t("rank.label")} aside={score?.promptVersion ? <PanelAside>{score.promptVersion}</PanelAside> : undefined}>
      <div className="flex flex-col gap-3" data-testid="rank-box">
        {notRanked ? (
          <div className="border-border text-ink-2 rounded-card flex flex-col gap-1 border-dashed border-[1.5px] px-4 py-3" data-rank="not-ranked">
            <span className="text-data text-ink-3 font-mono" aria-hidden>
              {UNKNOWN}/100
            </span>
            <b className="font-display text-h2 text-ink">{tRank("notRanked")}</b>
          </div>
        ) : scored ? (
          <>
            <JobViewTransition id={jobId} part="score">
              <div className="w-fit max-w-full" data-rank="ranked">
                <ScoreMeter value={score.rankValue} pushLine={pushLine} size="xl" match={score.score} bonus={bonus} />
              </div>
            </JobViewTransition>
            <ScoreComposition match={score.score} bonus={bonus} bonusCap={bonusCap} pushLine={pushLine} />
          </>
        ) : (
          // not scored yet: one dashed box (the design's null state), not an empty meter and an empty bar
          <JobViewTransition id={jobId} part="score">
            <div className="border-border text-ink-2 rounded-card flex flex-col gap-1 border-dashed border-[1.5px] px-4 py-3" data-rank="pending">
              <span className="text-data text-ink-3 font-mono" aria-hidden>
                {UNKNOWN}/100
              </span>
              <b className="font-display text-h2 text-ink">{t("rank.unscored")}</b>
              <span className="text-body-sm">{tRank("pending")}</span>
            </div>
          </JobViewTransition>
        )}
        {scoreNow}
        {scored ? (
          <dl className="text-muted-foreground text-data grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 font-mono" data-testid="rank-breakdown">
            {score.aiScore !== null && score.germanPenalty > 0 ? (
              <>
                <dt>{t("rank.aiScore")}</dt>
                <dd className="text-foreground text-right tabular-nums">{formatRank(score.aiScore)}</dd>
                <dt>{t("rank.german", { language: languageName ?? "" })}</dt>
                <dd className="text-foreground text-right tabular-nums">−{formatRank(score.germanPenalty)}</dd>
              </>
            ) : null}
            <dt>{t("rank.match")}</dt>
            <dd className="text-foreground text-right tabular-nums">{score.score === null ? "—" : formatRank(score.score)}</dd>
            <dt>{t("rank.bonus")}</dt>
            <dd className="text-foreground text-right tabular-nums">+{formatRank(score.signalBonus)}</dd>
          </dl>
        ) : null}
        {score?.stale ? (
          <p className="text-muted-foreground text-body-sm" data-testid="score-stale" title={tRank("staleHint")}>
            {t("rank.staleNote")}
          </p>
        ) : null}
        {meta ? (
          <p className="text-ink-3 text-data-sm font-mono" data-testid="score-meta">
            {meta}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
