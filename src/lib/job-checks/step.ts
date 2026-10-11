/**
 * The loop every job check of the `signals` step (and of its catch-up command) runs: list the jobs whose stored result is missing
 * or was made from other inputs (never-checked jobs first, newest first, at most `limit`), evaluate each, store it. One job that
 * fails costs that job only (it is retried next time); the step itself never throws.
 */
import type { ChannelLogger } from "@/lib/channels/types";
import type { Executor } from "@/lib/db/executor";

import { checkTableReady, type JobCheckTable } from "./table";

/** A job to check: its id and the hash of the inputs the result will be made from. */
export interface JobCheckCandidate {
  jobId: number;
  inputHash: string;
  /** The job was never checked. */
  fresh: boolean;
}

/** What one check plugs into the loop. */
export interface JobCheckSpec<C extends JobCheckCandidate, X, R> {
  table: JobCheckTable;
  /** Candidates, in the order to check them. */
  list(db: Executor, limit: number): Promise<C[]>;
  /** What a batch needs besides the candidates (e.g. the trap spans of these jobs); read once per batch. */
  prepare(db: Executor, batch: readonly C[]): Promise<X>;
  evaluate(candidate: C, context: X): R;
  /** Stores the result (or, with `write: false`, compares it with the stored one); whether it differs from what was stored. */
  save(db: Executor, candidate: C, result: R, options: { write: boolean }): Promise<boolean>;
}

export interface JobCheckRunOptions {
  limit: number;
  logger: Pick<ChannelLogger, "warn" | "error">;
  signal?: AbortSignal;
  /** false: compute and compare only, nothing is written. Default true. */
  write?: boolean;
  /** Jobs per database round trip. */
  batchSize?: number;
}

export interface JobCheckOutcome<R> {
  jobId: number;
  changed: boolean;
  result: R;
}

export interface JobCheckRunResult<R> {
  /** The table is not migrated yet: nothing ran. */
  skipped?: "no_table";
  scanned: number;
  /** Jobs whose stored result changed (or would change, in a preview). */
  changed: number;
  failed: number;
  aborted: boolean;
  outcomes: Array<JobCheckOutcome<R>>;
}

const DEFAULT_BATCH = 100;

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown error");

export async function runJobCheck<C extends JobCheckCandidate, X, R>(db: Executor, spec: JobCheckSpec<C, X, R>, options: JobCheckRunOptions): Promise<JobCheckRunResult<R>> {
  const result: JobCheckRunResult<R> = { scanned: 0, changed: 0, failed: 0, aborted: false, outcomes: [] };
  if (!(await checkTableReady(db, spec.table))) {
    options.logger.warn("job check skipped: its table is not migrated yet", { table: spec.table });
    return { ...result, skipped: "no_table" };
  }
  const write = options.write ?? true;
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const candidates = await spec.list(db, options.limit);
  for (let at = 0; at < candidates.length; at += batchSize) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }
    const batch = candidates.slice(at, at + batchSize);
    const context = await spec.prepare(db, batch);
    for (const candidate of batch) {
      if (options.signal?.aborted) {
        result.aborted = true;
        break;
      }
      try {
        const outcome = spec.evaluate(candidate, context);
        const changed = await spec.save(db, candidate, outcome, { write });
        result.scanned += 1;
        if (changed) result.changed += 1;
        result.outcomes.push({ jobId: candidate.jobId, changed, result: outcome });
      } catch (error) {
        result.failed += 1;
        options.logger.error("job check failed for a job", { table: spec.table, jobId: candidate.jobId, error: describe(error) });
      }
    }
  }
  return result;
}

/** What a check reports to its step: `failed` makes the `signals` step `partial`; `summary` goes to `cycles.summary_json`. */
export interface JobCheckStepOutcome {
  failed: boolean;
  summary: Record<string, unknown>;
}

/**
 * A check inside the `signals` step: its own error boundary (a throw becomes `failed`, never an exception), and a small summary.
 * `run` returns null when the check is off.
 */
export async function runJobCheckStep<R>(
  name: string,
  logger: Pick<ChannelLogger, "info" | "error">,
  run: () => Promise<JobCheckRunResult<R> | null>,
): Promise<JobCheckStepOutcome> {
  try {
    const result = await run();
    if (result === null) return { failed: false, summary: { skipped: "disabled" } };
    const counts = { ...(result.skipped ? { skipped: result.skipped } : {}), scanned: result.scanned, changed: result.changed, failed: result.failed, aborted: result.aborted };
    if (result.scanned > 0) logger.info(`${name} check done`, { ...counts });
    return { failed: result.failed > 0, summary: counts };
  } catch (error) {
    const reason = describe(error);
    logger.error(`${name} check failed`, { error: reason });
    return { failed: true, summary: { error: reason } };
  }
}
