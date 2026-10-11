import { useTranslations } from "next-intl";

import type { JobRank } from "@/lib/db/queries/types";
import { isNoteReason, parseFilterReason } from "@/lib/filter/reasons";

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

/**
 * Detail page: why the hard filter removed the job, or, for a kept job, what the posting leaves
 * open (unknown remote scope / city). With a `jobId` the notice also carries the user's override
 * button (keep a filtered job, exclude a passed one, take a decision back) unless `withButton` is false and the page
 * puts `FilterOverrideAction` among its other actions. `floor` lets a salary reason name the floor used at filter time
 * and say when the floor has changed since.
 */
export function FilterNotice({ rank, jobId, floor, withButton = true }: { rank: Rank | null; jobId?: number; floor?: FloorContext; withButton?: boolean }) {
  const t = useTranslations("filter");
  const text = useFilterReasonText({ floorAtFilter: floor?.atFilter ?? null, currency: floor?.currency ?? "" });
  if (rank === null) return null;

  const codes = rank.filterReasons.map((r) => parseFilterReason(r).code);
  const keptByUser = codes.includes("override_keep");
  const excludedByUser = codes.includes("override_exclude");
  const showButton = withButton && jobId !== undefined;

  if (rank.filterResult === "filtered_out") {
    // the user's own marker is not a rule reason: it gets its own wording, the rule reasons follow
    const ruleReasons = rank.filterReasons.filter((r) => parseFilterReason(r).code !== "override_exclude").map(text).join("; ");
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
      </div>
    );
  }

  const notes = rank.filterReasons.filter((r) => isNoteReason(r) && parseFilterReason(r).code !== "override_keep").map(text);
  const wouldHaveExcluded = rank.filterReasons.filter((r) => !isNoteReason(r)).map(text).join("; ");
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
    </div>
  );
}
