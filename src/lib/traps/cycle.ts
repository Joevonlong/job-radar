/** The trap scan inside the cycle's `signals` step: its own error boundary, a small summary for `cycles.summary_json`. */
import type { CycleStepContext } from "@/lib/cycle/steps";
import type { Executor } from "@/lib/db/executor";

import { readTrapsSettings } from "./settings";
import { runTrapScan, type ChannelLookup } from "./step";

const NO_CHANNELS: ChannelLookup = { get: () => undefined };

/** Job ids of the summary (the full list is for `pnpm traps:scan`). */
const SUMMARY_JOB_IDS = 20;

export interface TrapScanStepOutcome {
  /** The scan threw or traps.yaml is unreadable: the `signals` step is `partial`, the signals themselves still run. */
  failed: boolean;
  summary: Record<string, unknown>;
}

export async function runTrapScanStep(ctx: Pick<CycleStepContext, "channels" | "logger" | "signal">, db: Executor): Promise<TrapScanStepOutcome> {
  try {
    const settings = readTrapsSettings();
    if (settings === null) {
      ctx.logger.warn("ai trap scan skipped: traps.yaml cannot be read");
      return { failed: true, summary: { skipped: "config_error" } };
    }
    // without a channel registry (a step run outside the runner) only the JD text is scanned
    const channels = (ctx.channels as Partial<CycleStepContext["channels"]> | undefined)?.registry ?? NO_CHANNELS;
    const result = await runTrapScan(db, { settings, channels, logger: ctx.logger, limit: settings.scan.per_cycle_limit, signal: ctx.signal });
    const { jobs, ...counts } = result;
    if (result.scanned > 0) ctx.logger.info("ai trap scan done", { ...counts });
    return { failed: result.failed > 0, summary: { ...counts, trapJobIds: jobs.filter((j) => j.traps > 0).slice(0, SUMMARY_JOB_IDS).map((j) => j.jobId) } };
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown error";
    ctx.logger.error("ai trap scan failed", { error: reason });
    return { failed: true, summary: { error: reason } };
  }
}
