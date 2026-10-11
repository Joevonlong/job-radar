/**
 * The stored visa check: inside the cycle's `signals` step (after the trap scan) and in `pnpm visa:scan`. Jobs whose JD, rules,
 * company or hidden JD pieces changed since their last check are checked again (never-checked first, newest first), at most
 * `per_cycle_limit` per cycle. Hits inside hidden text (the AI trap findings) do not count. Nothing here touches a score.
 */
import type { ChannelLogger } from "@/lib/channels/types";
import type { CycleStepContext } from "@/lib/cycle/steps";
import type { Executor } from "@/lib/db/executor";
import { listJobsToVisaScan, loadVisaScanInputs, saveVisaScan, type VisaScanCandidate, type VisaScanInput } from "@/lib/db/repos/visa";
import { trapTablesReady } from "@/lib/db/repos/traps";
import { runJobCheck, runJobCheckStep, type JobCheckRunResult, type JobCheckSpec, type JobCheckStepOutcome } from "@/lib/job-checks";
import { loadPipeline } from "@/lib/market/effective";
import { loadTrapSpans } from "@/lib/traps/clean";
import { readTrapsSettings } from "@/lib/traps/settings";
import type { TrapSpan } from "@/lib/traps/types";

import { detectVisa } from "./detect";
import { visaRulesFingerprint } from "./fingerprint";
import { visaRulesFor, type CompiledVisaRules } from "./rules";
import { readVisaSettings } from "./settings";
import type { VisaResult } from "./types";

export interface VisaScanOptions {
  rules: CompiledVisaRules;
  /** `visaRulesFingerprint` of the config the rules were compiled from. */
  rulesHash: string;
  limit: number;
  logger: Pick<ChannelLogger, "warn" | "error">;
  signal?: AbortSignal;
  /** Only these jobs. */
  jobIds?: readonly number[];
  /** Check the listed jobs even when their result is current. */
  force?: boolean;
  /** false: compute and compare only (the preview of `pnpm visa:scan`). Default true. */
  write?: boolean;
}

interface BatchContext {
  inputs: Map<number, VisaScanInput>;
  spans: Map<number, TrapSpan[]>;
}

/** Whether the hidden pieces of the JD count: the trap tables exist and traps.yaml has the check on. */
async function trapSpansApply(db: Executor): Promise<boolean> {
  return readTrapsSettings()?.enabled === true && (await trapTablesReady(db));
}

export async function runVisaScan(db: Executor, options: VisaScanOptions): Promise<JobCheckRunResult<VisaResult>> {
  const withTrapSpans = await trapSpansApply(db);
  const spec: JobCheckSpec<VisaScanCandidate, BatchContext, VisaResult> = {
    table: "job_visa",
    list: (d, limit) => listJobsToVisaScan(d, { rulesHash: options.rulesHash, limit, withTrapSpans, jobIds: options.jobIds ?? null, force: options.force === true }),
    async prepare(d, batch) {
      const rows = await loadVisaScanInputs(d, batch.map((c) => c.jobId));
      const inputs = new Map(rows.map((row) => [row.jobId, row]));
      const spans = withTrapSpans
        ? await loadTrapSpans(
            d,
            rows.map((row) => ({ jobId: row.jobId, description: row.description ?? "" })),
            { logger: options.logger },
          )
        : new Map<number, TrapSpan[]>();
      return { inputs, spans };
    },
    evaluate(candidate, context) {
      const input = context.inputs.get(candidate.jobId);
      if (!input) throw new Error("job not found");
      return detectVisa(input.description, options.rules, { companyNameNorm: input.companyNameNorm, trapSpans: context.spans.get(candidate.jobId) ?? [] });
    },
    save: (d, candidate, result, { write }) => saveVisaScan(d, { jobId: candidate.jobId, status: result.status, evidence: result.evidence, inputHash: candidate.inputHash }, { write }),
  };
  return runJobCheck(db, spec, {
    limit: options.limit,
    logger: options.logger,
    write: options.write ?? true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** The visa check inside the `signals` step: its own error boundary (a failure makes the step `partial`), a small summary. */
export function runVisaScanStep(ctx: Pick<CycleStepContext, "logger" | "signal">, db: Executor): Promise<JobCheckStepOutcome> {
  return runJobCheckStep("visa", ctx.logger, async () => {
    if (!readVisaSettings().enabled) return null;
    const pipeline = loadPipeline();
    const rules = visaRulesFor(pipeline);
    return runVisaScan(db, { rules, rulesHash: visaRulesFingerprint(pipeline), limit: pipeline.job_checks.visa.per_cycle_limit, logger: ctx.logger, signal: ctx.signal });
  });
}
