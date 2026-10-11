import type { CycleStepContext, StepResult } from "@/lib/cycle/steps";
import { registerCycleStep } from "@/lib/cycle/steps";
import { ensureProfileFiles, parseConfigText, readConfigText, type PipelineConfig, type PreferencesConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import {
  getFilterOverrides,
  getFilterResults,
  insertFilterResults,
  listFilterCandidates,
  updateFilterResult,
  type FilterCandidate,
  type NewFilterResult,
  type ProfileSnapshot,
} from "@/lib/db";
import { parseLocations, parseSalary } from "@/lib/db/queries/parse";
import { snapshotForProfileText } from "@/lib/profile/snapshots";
import type { ChannelLogger } from "@/lib/channels/types";

import { compileFilter, evaluateJob, type CompiledFilter, type FilterJob } from "./rules";

export { applyOverride, compileFilter, evaluateJob, foldText, wholeWordPattern, type CompiledFilter, type FilterJob, type FilterOverride, type FilterResult, type FilterVerdict } from "./rules";
export * from "./reasons";

export interface FilterRunResult {
  /** The preferences snapshot the results belong to. */
  snapshotId: number;
  /** Jobs looked at (not closed). */
  evaluated: number;
  /** New (job, snapshot) results. */
  created: number;
  /** Existing results whose outcome changed because the job changed. */
  updated: number;
  /** Existing results that were already right: nothing written. */
  unchanged: number;
  passed: number;
  filteredOut: number;
  /** How often each reason code applies over all evaluated jobs. */
  byReason: Record<string, number>;
  aborted: boolean;
}

export interface FilterOptions {
  preferences: PreferencesConfig;
  /** The snapshot `preferences` was saved as. */
  snapshotId: number;
  pipeline: PipelineConfig;
  /** Only these jobs (the user changed the decision about one job); default: every job. */
  jobIds?: readonly number[];
  logger?: ChannelLogger;
  signal?: AbortSignal;
}

/** `jobs` row -> the fields the rules read. */
export function toFilterJob(row: FilterCandidate): FilterJob {
  return {
    title: row.title,
    description: row.description,
    companyName: row.companyName,
    companyAliases: row.companyAliases,
    companyBlacklisted: row.companyBlacklisted,
    locations: parseLocations(row.locationsJson),
    workplace: row.workplace,
    seniority: row.seniority,
    contract: row.contract,
    salary: parseSalary(row.salaryJson),
  };
}

const sameReasons = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Evaluate every job that is not closed against the preferences and store one result per (job,
 * profile snapshot) in `scores`. Idempotent: a second run with the same snapshot and the same jobs
 * writes nothing. Jobs that changed since (a source delivered new details) get their result updated
 * in place; when the preferences change the snapshot changes, so every job gets a new row.
 */
export async function runFilter(db: Db, options: FilterOptions): Promise<FilterRunResult> {
  const compiled: CompiledFilter = compileFilter(options.preferences, options.pipeline);
  const result: FilterRunResult = {
    snapshotId: options.snapshotId,
    evaluated: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    passed: 0,
    filteredOut: 0,
    byReason: {},
    aborted: false,
  };

  let afterId = 0;
  for (;;) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }
    const batch = await listFilterCandidates(db, { afterId, limit: options.pipeline.batch_size, jobIds: options.jobIds });
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]?.id ?? afterId;

    const ids = batch.map((j) => j.id);
    const stored = await getFilterResults(db, options.snapshotId, ids);
    const overrides = await getFilterOverrides(db, ids);
    const fresh: NewFilterResult[] = [];
    for (const row of batch) {
      const verdict = evaluateJob(toFilterJob(row), compiled, overrides.get(row.id) ?? null);
      result.evaluated += 1;
      if (verdict.result === "passed") result.passed += 1;
      else result.filteredOut += 1;
      for (const reason of verdict.reasons) {
        const code = reason.split(":", 1)[0] ?? reason;
        result.byReason[code] = (result.byReason[code] ?? 0) + 1;
      }

      const existing = stored.get(row.id);
      if (!existing) {
        fresh.push({ jobId: row.id, filterResult: verdict.result, filterReasons: verdict.reasons });
      } else if (existing.filterResult !== verdict.result || !sameReasons(existing.filterReasons, verdict.reasons)) {
        await updateFilterResult(db, existing.scoreId, { filterResult: verdict.result, filterReasons: verdict.reasons });
        result.updated += 1;
      } else {
        result.unchanged += 1;
      }
    }
    result.created += await insertFilterResults(db, options.snapshotId, fresh);
  }
  options.logger?.info("hard filter done", { snapshotId: result.snapshotId, evaluated: result.evaluated, created: result.created, updated: result.updated, filteredOut: result.filteredOut });
  return result;
}

export interface CurrentPreferences {
  preferences: PreferencesConfig;
  snapshot: ProfileSnapshot;
}

/**
 * The preferences file as it is now and the snapshot of exactly that text. Saving through the UI
 * stored the snapshot already; a file edited by hand gets one here (and, like a UI save, marks the
 * scores of other snapshots stale).
 */
export async function currentPreferences(db: Db): Promise<CurrentPreferences> {
  await ensureProfileFiles(); // a first cycle before the profile page was ever opened starts from the template
  const text = readConfigText("preferences");
  const preferences = parseConfigText("preferences", text);
  const snapshot = await snapshotForProfileText(db, "preferences", text);
  return { preferences, snapshot };
}

/**
 * Apply the user's decision about one job right away (the detail page's keep / exclude button): the
 * job's filter result under the current preferences is recomputed, so the page shows it without
 * waiting for the next cycle. Returns the new result, or null when the job is closed or unknown.
 */
export async function refilterJob(db: Db, jobId: number, logger?: ChannelLogger): Promise<{ filterResult: "passed" | "filtered_out"; filterReasons: string[] } | null> {
  const { preferences, snapshot } = await currentPreferences(db);
  const result = await runFilter(db, { preferences, snapshotId: snapshot.id, pipeline: loadPipeline(), jobIds: [jobId], logger });
  if (result.evaluated === 0) return null;
  const stored = await getFilterResults(db, snapshot.id, [jobId]);
  const row = stored.get(jobId);
  return row ? { filterResult: row.filterResult, filterReasons: row.filterReasons } : null;
}

function requireDb(ctx: CycleStepContext): Db {
  if (!ctx.db) throw new Error("this cycle step needs a database");
  return ctx.db;
}

/** Cycle step `filter` (between `pipeline` and `signals`). */
export async function filterStep(ctx: CycleStepContext): Promise<StepResult> {
  const db = requireDb(ctx);
  const { preferences, snapshot } = await currentPreferences(db);
  const result = await runFilter(db, { preferences, snapshotId: snapshot.id, pipeline: loadPipeline(), logger: ctx.logger, signal: ctx.signal });
  return { status: result.aborted ? "partial" : "ok", result };
}

/** Plug `filter` into the processing cycle (called once at start-up). */
export function registerFilterStep(): void {
  registerCycleStep("filter", filterStep);
}
