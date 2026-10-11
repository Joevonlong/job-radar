"use client";

import { ChevronRight } from "lucide-react";

import { toNumber } from "@/lib/settings/draft";
import { PRIORITY_SECTION_PREFIX, PRIORITY_WEIGHTS } from "@/lib/settings/fields";

import { FieldGroups } from "./fields-block";
import { aiSectionsOf, type AiTabContext } from "./context";

/** The section of the scoring criteria. */
const CRITERIA_SECTION = "scoring_criteria";

/** Sum of the six pre-score weights as typed (an empty or invalid box counts as 0): shown for reference, it does not have to be 100. */
export function priorityWeightSum(draft: AiTabContext["draft"]): number {
  return PRIORITY_WEIGHTS.reduce((sum, key) => {
    const value = draft[`scoring.priority.weights.${key}`];
    const parsed = typeof value === "string" ? toNumber(value) : undefined;
    return sum + (parsed !== undefined && Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}

/**
 * Block 4: how a JD is cut and batched for scoring, the German-level penalties, and the "pre-sort": the AI-free pre-score that
 * decides which waiting jobs the AI scores first. The pre-sort is folded (rarely changed) and opens by itself when a field in it has a problem.
 */
export function ScoringSection({ ctx }: { ctx: AiTabContext }) {
  const { t } = ctx;
  const all = aiSectionsOf("scoring");
  const main = all.filter((section) => !section.id.startsWith(PRIORITY_SECTION_PREFIX));
  const priority = all.filter((section) => section.id.startsWith(PRIORITY_SECTION_PREFIX));
  const hasError = priority.some((section) => section.fields.some((def) => ctx.errors.has(def.path)));
  const changed = priority.reduce((count, section) => count + section.fields.filter((def) => ctx.dirty.has(def.path)).length, 0);
  // Changed criteria re-score; say how many before the save
  const criteriaChanged = main.some((section) => section.id === CRITERIA_SECTION && section.fields.some((def) => ctx.dirty.has(def.path)));
  const impact = ctx.criteriaImpact ?? null;
  return (
    <>
      <FieldGroups sections={main} ctx={ctx} />
      {criteriaChanged ? (
        <p role="status" className="border-warning/40 bg-warning/10 text-body-sm rounded-card border-bw px-3 py-2" data-testid="criteria-impact" data-count={impact ?? ""}>
          {impact === null ? t("ai.criteriaImpactUnknown") : t("ai.criteriaImpact", { count: impact })}
        </p>
      ) : null}
      <details className="border-border group rounded-card border-bw bg-card" data-testid="priority-block" {...(hasError ? { open: true } : {})}>
        <summary className="hover:bg-soft flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-card px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="text-ink-3 size-4 transition-transform group-open:rotate-90" />
          <span className="text-title">{t("ai.priority.title")}</span>
          <span className="text-ink-2 text-data font-mono" data-testid="priority-sum">
            {t("ai.priority.sum", { sum: priorityWeightSum(ctx.draft) })}
          </span>
          {changed > 0 ? <span className="text-on-signal bg-warn border-border ml-auto rounded-tag border-bw px-2 text-data font-mono">{t("controls.changed")} {changed}</span> : null}
        </summary>
        <div className="flex flex-col gap-4 px-3 pt-1 pb-3">
          <p className="text-ink-2 text-body-sm">{t("ai.priority.hint")}</p>
          <FieldGroups sections={priority} ctx={ctx} />
        </div>
      </details>
    </>
  );
}
