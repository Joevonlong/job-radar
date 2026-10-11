import type { getTranslations } from "next-intl/server";

import { cycleStateFace, type CycleStateFace } from "@/lib/cycle/step-health";
import type { CycleSummary } from "@/lib/db/queries/today";

export type Translator = Awaited<ReturnType<typeof getTranslations<"dashboard.cycle">>>;

/** Text colour of a cycle's state words: normal, warn (a step or a source failed) or bad (the cycle failed). */
export const STATE_TONE: Record<CycleStateFace["tone"], string> = { ok: "", warn: "text-warning-text font-semibold", bad: "text-destructive font-semibold" };

export function cycleFace(cycle: Pick<CycleSummary, "status" | "steps" | "failedChannels" | "finishedAt">): CycleStateFace {
  return cycleStateFace({ status: cycle.status, steps: cycle.steps, failedChannels: cycle.failedChannels, finished: cycle.finishedAt !== null });
}

/** "finished 07:09", "partly failed: Process / Filter / Scoring failed": a cycle that did not do its job never reads as finished. */
export function stateWords(t: Translator, face: CycleStateFace, time: (date: Date) => string, cycle: Pick<CycleSummary, "finishedAt">): string {
  const steps = face.steps.map((name) => t(`step.${name}`)).join(t("stepJoiner"));
  switch (face.key) {
    case "finished":
      return t("state.finished", { time: cycle.finishedAt ? time(cycle.finishedAt) : "" });
    case "partialSteps":
      return t("state.partialSteps", { steps });
    case "failedSteps":
      return t("state.failedSteps", { steps });
    default:
      return t(`state.${face.key}`);
  }
}
