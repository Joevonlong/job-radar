/**
 * What a finished cycle says about its own steps. `cycles.status = partial` only means "something went wrong";
 * `cycles.summary_json.steps[]` says which step it was. The Today page, the sidebar and /sources read the failed steps from
 * here, so a cycle that fetched postings but could not process them never reads as "finished".
 *
 * Pure: no database, no clock, no imports of the cycle runner (client components use the types and constants). Reading
 * `summary_json` is a boundary, so it is parsed with zod (C6).
 */
import { z } from "zod";

/** The cycle steps in run order (mirrors `CYCLE_STEP_NAMES` of `./steps`, which pulls in the whole runner). */
export const STEP_NAMES = ["collect", "pipeline", "filter", "signals", "ai", "notify", "maintenance"] as const;
export type StepName = (typeof STEP_NAMES)[number];

export type StepStatus = "ok" | "partial" | "failed" | "skipped";

export interface CycleStepStatus {
  name: StepName;
  status: StepStatus;
  /** The step's own error text (technical; shown under "details" only). */
  error: string | null;
}

const summarySchema = z.object({
  steps: z.array(z.object({ name: z.string(), status: z.enum(["ok", "partial", "failed", "skipped"]).catch("ok"), error: z.string().optional() })),
});

export function isStepName(name: string): name is StepName {
  return (STEP_NAMES as readonly string[]).includes(name);
}

/** The steps recorded in `cycles.summary_json`, in run order; unknown step names and a missing / odd summary give []. */
export function readCycleSteps(summaryJson: unknown): CycleStepStatus[] {
  const parsed = summarySchema.safeParse(summaryJson);
  if (!parsed.success) return [];
  return parsed.data.steps.flatMap((step) => (isStepName(step.name) ? [{ name: step.name, status: step.status, error: step.error ?? null }] : []));
}

/** Steps that did not do their job: failed ones, then partial ones (a partly failed `collect` is the failed sources, which have their own line). */
export function problemSteps(steps: readonly CycleStepStatus[]): { failed: StepName[]; partial: StepName[] } {
  return {
    failed: steps.filter((s) => s.status === "failed").map((s) => s.name),
    partial: steps.filter((s) => s.status === "partial" && s.name !== "collect").map((s) => s.name),
  };
}

export type KpiBlockKey = "passed" | "qualified" | "salary" | "pushed";
export type UnprocessedReason = "unprocessed" | "unscored";

/**
 * Which summary blocks of a cycle cannot be trusted because a step they depend on failed:
 * "passed the filter" and "salary stated" need `pipeline` and `filter`; "at or above the push line" needs the AI score as well;
 * "pushed" needs `notify`. `unprocessed` = the pipeline / filter never turned the postings into judged jobs; `unscored` = only the
 * AI score (or the pay signals it adds to the rank) is missing. A block that is not listed is fine: a 0 there is a real 0.
 */
export function unprocessedBlocks(steps: readonly CycleStepStatus[]): Partial<Record<KpiBlockKey, UnprocessedReason>> {
  const failed = new Set(steps.filter((s) => s.status === "failed").map((s) => s.name));
  const partial = new Set(steps.filter((s) => s.status === "partial").map((s) => s.name));
  const result: Partial<Record<KpiBlockKey, UnprocessedReason>> = {};
  if (failed.has("pipeline") || failed.has("filter")) {
    result.passed = "unprocessed";
    result.salary = "unprocessed";
    result.qualified = "unprocessed";
  } else if (failed.has("ai") || failed.has("signals")) {
    result.qualified = "unscored";
  }
  // a push that only partly went out has no trustworthy count either: the strip says so, like the failed step list does
  if (failed.has("notify") || partial.has("notify")) result.pushed = "unprocessed";
  return result;
}

/** Whether the cycle's postings were left unprocessed (the pipeline or the filter failed): the empty state says so. */
export function processingFailed(steps: readonly CycleStepStatus[]): boolean {
  return steps.some((s) => s.status === "failed" && (s.name === "pipeline" || s.name === "filter"));
}

export type CycleStatusValue = "running" | "succeeded" | "partial" | "failed" | "skipped";

/**
 * How a cycle's end is worded. `finished` only when nothing went wrong; a partial or failed cycle names what did not work.
 * `tone`: `ok` normal, `warn` partial (it ran, something did not), `bad` failed. `steps` are the steps to name (failed first,
 * then the partly done ones); `key` is the message key under `dashboard.cycle.state`.
 */
export interface CycleStateFace {
  tone: "ok" | "warn" | "bad";
  key: "running" | "finished" | "succeeded" | "partialSteps" | "partialSources" | "partial" | "failedSteps" | "failed" | "skipped";
  steps: StepName[];
}

export function cycleStateFace(cycle: { status: CycleStatusValue; steps: readonly CycleStepStatus[]; failedChannels?: number; finished?: boolean }): CycleStateFace {
  const { failed, partial } = problemSteps(cycle.steps);
  const named = [...failed, ...partial.filter((name) => !failed.includes(name))];
  switch (cycle.status) {
    case "running":
      return { tone: "ok", key: "running", steps: [] };
    case "skipped":
      return { tone: "ok", key: "skipped", steps: [] };
    case "failed":
      return named.length > 0 ? { tone: "bad", key: "failedSteps", steps: named } : { tone: "bad", key: "failed", steps: [] };
    case "partial":
      if (named.length > 0) return { tone: "warn", key: "partialSteps", steps: named };
      return (cycle.failedChannels ?? 0) > 0 ? { tone: "warn", key: "partialSources", steps: [] } : { tone: "warn", key: "partial", steps: [] };
    case "succeeded":
      return { tone: "ok", key: cycle.finished ? "finished" : "succeeded", steps: [] };
  }
}
