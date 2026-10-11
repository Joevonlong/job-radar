import { useTranslations } from "next-intl";

import type { JobRank } from "@/lib/db/queries/types";
import type { DealBreakerExplanation } from "@/lib/filter/deal-breakers";
import { isNoteReason, orderedReasons, parseFilterReason } from "@/lib/filter/reasons";

import { FilterOverrideButton, type OverrideAction } from "./filter-override-button";
import { floorChanged, FloorChangedText, useFilterReasonText, type FloorContext } from "./filter-reasons";

export type { FloorContext };

type Rank = Pick<JobRank, "filterResult" | "filterReasons">;

/** Which button the notice offers for a job: keep a filtered one, exclude a passed one, take the user's decision back. */
export function overrideActionOf(rank: Rank): OverrideAction {
  const codes = rank.filterReasons.map((r) => parseFilterReason(r).code);
  if (rank.filterResult === "filtered_out") return codes.includes("override_exclude") ? "clear" : "keep";
  return codes.includes("override_keep") ? "clear" : "exclude";
}

/** The filter's decision as an item of the "more" menu of the header actions (the row has no room for one more button): which action it is. */
export function overrideActionFor(rank: Rank | null): OverrideAction | null {
  return rank === null ? null : overrideActionOf(rank);
}

/** The filter's override button alone, for the row of header actions of the detail page. */
export function FilterOverrideAction({ rank, jobId }: { rank: Rank | null; jobId: number }) {
  if (rank === null) return null;
  return <FilterOverrideButton jobId={jobId} action={overrideActionOf(rank)} size="md" />;
}

/** The user's deal-breakers a job's reasons name: their names as they are now, and why each one applies (computed for the page). */
export interface DealBreakerNotice {
  labels: Readonly<Record<string, string>>;
  explanations: readonly DealBreakerExplanation[];
}

/** "CEFR level" or the words for none / native. */
function useLevelText(): (level: string) => string {
  const t = useTranslations("dealBreakers.levels");
  return (level) => (level === "none" ? t("none") : level === "native" ? t("native") : level);
}

/** Under the banner: each deal-breaker that applies, with the job's own words it rests on (verbatim) and, for a language gate, both levels. */
function DealBreakerExplanations({ notice }: { notice: DealBreakerNotice }) {
  const t = useTranslations("dealBreakers.notice");
  const tVisa = useTranslations("visa.badge");
  const level = useLevelText();
  if (notice.explanations.length === 0) return null;
  return (
    <ul className="flex w-full basis-full flex-col gap-2" data-testid="deal-breaker-explanations">
      {notice.explanations.map((e) => (
        <li key={e.id} className="flex min-w-0 flex-col gap-1" data-deal-breaker={e.id}>
          <span className="text-body-sm">
            <b>{t("rule", { label: notice.labels[e.id] ?? e.id })}</b>
            {e.required !== undefined ? (
              <span data-testid="deal-breaker-levels">
                {" "}
                {e.atLeast !== undefined
                  ? t("levelsThreshold", { required: e.required, threshold: e.atLeast })
                  : t("levels", { required: e.required, user: level(e.userLevel ?? "none") })}
              </span>
            ) : null}
            {e.visaKind ? (
              <span data-testid="deal-breaker-visa">
                {" "}
                {t("visa", { status: tVisa(e.visaKind) })}
              </span>
            ) : null}
          </span>
          {e.quote !== null ? (
            <blockquote className="border-border text-ink-2 border-l-bw pl-3 font-mono text-data break-words" data-testid="deal-breaker-quote" data-field={e.field ?? undefined}>
              {e.field === "title" ? <span className="text-ink-3">{t("inTitle")} </span> : null}
              {e.quote}
            </blockquote>
          ) : (
            <span className="text-ink-3 text-body-sm">{t("noQuote")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Detail page: why the hard filter removed the job, or, for a kept job, what the posting leaves
 * open (unknown remote scope / city). With a `jobId` the notice also carries the user's override
 * button (keep a filtered job, exclude a passed one, take a decision back) unless `withButton` is false and the page
 * puts `FilterOverrideAction` among its other actions. `floor` lets a salary reason name the floor used at filter time
 * and say when the floor has changed since.
 */
export function FilterNotice({ rank, jobId, floor, withButton = true, dealBreakers }: { rank: Rank | null; jobId?: number; floor?: FloorContext; withButton?: boolean; dealBreakers?: DealBreakerNotice }) {
  const t = useTranslations("filter");
  const text = useFilterReasonText({ floorAtFilter: floor?.atFilter ?? null, currency: floor?.currency ?? "", ...(dealBreakers ? { dealBreakerLabels: dealBreakers.labels } : {}) });
  if (rank === null) return null;

  const codes = rank.filterReasons.map((r) => parseFilterReason(r).code);
  const keptByUser = codes.includes("override_keep");
  const excludedByUser = codes.includes("override_exclude");
  const showButton = withButton && jobId !== undefined;

  if (rank.filterResult === "filtered_out") {
    // the user's own marker is not a rule reason: it gets its own wording, the rule reasons follow
    const ruleReasons = orderedReasons(rank.filterReasons.filter((r) => parseFilterReason(r).code !== "override_exclude")).map(text).join("; ");
    const changed = floorChanged(rank.filterReasons, floor);
    return (
      <div role="note" className="border-destructive/40 bg-destructive/8 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5" data-testid="filter-banner">
        <span>
          {excludedByUser ? `${t("override.excludedBanner")} ` : ""}
          {excludedByUser && ruleReasons === "" ? "" : t("banner", { reasons: ruleReasons || t("noReason") })}
          {changed ? (
            <>
              {" "}
              <FloorChangedText floor={floor.current} currency={floor.currency ?? ""} />
            </>
          ) : null}
        </span>
        {showButton ? <FilterOverrideButton jobId={jobId} action={excludedByUser ? "clear" : "keep"} /> : null}
        {dealBreakers ? <DealBreakerExplanations notice={dealBreakers} /> : null}
      </div>
    );
  }

  const notes = rank.filterReasons.filter((r) => isNoteReason(r) && parseFilterReason(r).code !== "override_keep").map(text);
  const wouldHaveExcluded = orderedReasons(rank.filterReasons.filter((r) => !isNoteReason(r))).map(text).join("; ");
  if (notes.length === 0 && !keptByUser) {
    // nothing to say about a clean job: just the small "exclude" button
    return showButton ? (
      <div className="flex justify-end" data-testid="filter-override-row">
        <FilterOverrideButton jobId={jobId} action="exclude" />
      </div>
    ) : null;
  }
  return (
    <div role="note" className="border-border bg-muted/50 text-muted-foreground flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2" data-testid="filter-note">
      <span>
        {keptByUser ? (wouldHaveExcluded ? t("override.keptBanner", { reasons: wouldHaveExcluded }) : t("override.keptBannerPlain")) : ""}
        {keptByUser && notes.length > 0 ? " " : ""}
        {notes.length > 0 ? t("noteBanner", { notes: notes.join("; ") }) : ""}
      </span>
      {showButton ? <FilterOverrideButton jobId={jobId} action={keptByUser ? "clear" : "exclude"} /> : null}
      {keptByUser && dealBreakers ? <DealBreakerExplanations notice={dealBreakers} /> : null}
    </div>
  );
}
