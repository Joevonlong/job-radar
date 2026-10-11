/**
 * The stored ghost job check: inside the cycle's `signals` step (after the trap and visa checks) and in `pnpm ghost:check`. Jobs whose
 * inputs changed since their last check, or that reached the next "open for long" tier, are checked again (never-checked first,
 * newest first), at most `per_cycle_limit` per cycle. Nothing here touches a score, a filter or a push (C3).
 */
import { createHash } from "node:crypto";

import { ChannelRegistry } from "@/lib/channels/registry";
import { registerBuiltinChannels } from "@/lib/channels/builtin";
import type { ChannelLogger } from "@/lib/channels/types";
import type { PipelineConfig } from "@/lib/config/schemas/pipeline";
import type { CycleStepContext } from "@/lib/cycle/steps";
import type { Executor } from "@/lib/db/executor";
import { listJobsToGhostCheck, loadGhostInputs, saveGhostCheck, type GhostCheckCandidate, type GhostInputRow } from "@/lib/db/repos/ghost";
import { trapTablesReady } from "@/lib/db/repos/traps";
import { runJobCheck, runJobCheckStep, type JobCheckRunResult, type JobCheckSpec, type JobCheckStepOutcome } from "@/lib/job-checks";
import { loadPipeline } from "@/lib/market/effective";
import { loadTrapSpans } from "@/lib/traps/clean";
import { overlapsTrap } from "@/lib/traps/ai-input";
import { readTrapsSettings } from "@/lib/traps/settings";
import type { TrapSpan } from "@/lib/traps/types";

import { evaluateGhost } from "./evaluate";
import { ghostRulesFingerprint } from "./fingerprint";
import { buildGhostInput, ghostChannels, type GhostChannel, type GhostChannels } from "./inputs";
import { ghostRulesFor, type CompiledGhostRules } from "./rules";
import { readGhostSettings, trustedCompanyKeys } from "./settings";
import type { GhostResult } from "./types";

export interface GhostCheckOptions {
  rules: CompiledGhostRules;
  /** `ghostRulesFingerprint` of the config the rules were compiled from. */
  rulesHash: string;
  channels: GhostChannels;
  /** ui.yaml `trusted_companies` as `companies.name_norm` keys. */
  trustedKeys: readonly string[];
  limit: number;
  logger: Pick<ChannelLogger, "warn" | "error">;
  now: Date;
  signal?: AbortSignal;
  /** Only these jobs. */
  jobIds?: readonly number[];
  /** Check the listed jobs even when their result is current. */
  force?: boolean;
  /** false: compute and compare only (the preview of `pnpm ghost:check`). Default true. */
  write?: boolean;
}

interface BatchContext {
  inputs: Map<number, GhostInputRow>;
  spans: Map<number, TrapSpan[]>;
}

/** Whether the hidden pieces of the JD count: the trap tables exist and traps.yaml has the check on. */
async function trapSpansApply(db: Executor): Promise<boolean> {
  return readTrapsSettings()?.enabled === true && (await trapTablesReady(db));
}

/** The channels of a registry, or of the built-in one when the step runs without (a script, a test). */
export function ghostChannelsOf(registry: { list(): readonly GhostChannel[] } | undefined): GhostChannels {
  if (registry) return ghostChannels(registry.list());
  const builtin = new ChannelRegistry();
  registerBuiltinChannels(builtin);
  return ghostChannels(builtin.list());
}

export async function runGhostCheck(db: Executor, options: GhostCheckOptions): Promise<JobCheckRunResult<GhostResult>> {
  const withTrapSpans = await trapSpansApply(db);
  const trusted = new Set(options.trustedKeys);
  // the rules, the limits and the channels' declarations together: a change of any checks every job again
  const rulesHash = createHash("sha256").update(`${options.rulesHash}:${options.channels.key}`).digest("hex").slice(0, 32);
  const spec: JobCheckSpec<GhostCheckCandidate, BatchContext, GhostResult> = {
    table: "job_ghost",
    list: (d, limit) =>
      listJobsToGhostCheck(d, {
        rulesHash,
        trustedKeys: options.trustedKeys,
        payloadChannels: options.channels.payloadChannels,
        withTrapSpans,
        limit,
        now: options.now,
        jobIds: options.jobIds ?? null,
        force: options.force === true,
      }),
    async prepare(d, batch) {
      const rows = await loadGhostInputs(d, batch.map((c) => c.jobId), { payloadChannels: options.channels.payloadChannels });
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
      const row = context.inputs.get(candidate.jobId);
      if (!row) throw new Error("job not found");
      const spans = context.spans.get(candidate.jobId) ?? [];
      const skip = spans.length === 0 ? undefined : (start: number, end: number): boolean => overlapsTrap(start, end - start, spans);
      return evaluateGhost(buildGhostInput(row, options.channels, trusted), options.rules, options.now, skip ? { skip } : {});
    },
    save: (d, candidate, result, { write }) =>
      saveGhostCheck(d, { jobId: candidate.jobId, level: result.level, score: result.score, reasons: result.reasons, inputHash: candidate.inputHash, recheckAt: result.recheckAt }, { write }),
  };
  return runJobCheck(db, spec, {
    limit: options.limit,
    logger: options.logger,
    write: options.write ?? true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Everything `runGhostCheck` needs from the current config files. */
export function ghostCheckConfig(pipeline: PipelineConfig = loadPipeline()): Pick<GhostCheckOptions, "rules" | "rulesHash" | "trustedKeys" | "limit"> {
  return {
    rules: ghostRulesFor(pipeline),
    rulesHash: ghostRulesFingerprint(pipeline),
    trustedKeys: trustedCompanyKeys(readGhostSettings().trusted_companies, pipeline),
    limit: pipeline.job_checks.ghost.per_cycle_limit,
  };
}

/** The ghost job check inside the `signals` step: off unless ui.yaml turns it on; its own error boundary (a failure makes the step `partial`). */
export function runGhostCheckStep(ctx: Pick<CycleStepContext, "logger" | "signal" | "now"> & { channels?: Partial<CycleStepContext["channels"]> }, db: Executor): Promise<JobCheckStepOutcome> {
  return runJobCheckStep("ghost", ctx.logger, async () => {
    if (!readGhostSettings().enabled) return null;
    const config = ghostCheckConfig();
    return runGhostCheck(db, { ...config, channels: ghostChannelsOf(ctx.channels?.registry), logger: ctx.logger, now: ctx.now(), signal: ctx.signal });
  });
}
