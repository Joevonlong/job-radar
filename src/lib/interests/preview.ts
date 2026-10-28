/**
 * "Try on recent jobs" of a category on /interests. The rule stage (`findCandidates`, no AI) runs the draft's
 * category over the newest `limits.preview_jobs` open jobs in memory and reports how many it would hit, with a few
 * quoted samples; when the draft changes what the AI looks for (the signals prompt version), it also estimates how many
 * jobs the next cycles review again. Read only: no AI call, no write (C5: nothing leaves the machine).
 */
import { z } from "zod";

import { ConfigError, interestsSchema, reloadConfig, type InterestsConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { countJobsToReview, listRecentJobsForPreview } from "@/lib/db/repos/signals";
import type { TimeBox } from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { loadPipeline } from "@/lib/market";
import { findCandidates, signalPatternGuard, signalProbeLimits, signalsPrompt, type RuleCandidate } from "@/lib/signals";
import { compileSignalRules } from "@/lib/signals/rules";

import { slowPatternErrors } from "./pattern-check";
import { draftToCandidate, toFieldErrors, vocabularyDraftSchema, type VocabularyFieldError } from "./vocabulary-draft";

const log = createProcessLogger({ fields: { component: "interests-preview" } });

/** Quoted samples the preview shows at most. */
export const PREVIEW_SAMPLES = 3;

export const categoryPreviewRequestSchema = z.strictObject({
  /** The whole form as it is now: the estimate compares it with the saved file. */
  draft: vocabularyDraftSchema,
  categoryId: z.string().min(1).max(60),
});

export interface CategoryPreviewSample {
  jobId: number;
  title: string;
  quote: string;
}

export interface ReviewEstimate {
  /** Jobs the AI reads again after the save (the `signals` step's own selection). */
  jobs: number;
  /** Cycles that takes at `ai.yaml: per_cycle_limit`; null when ai.yaml cannot be read. */
  rounds: number | null;
  perCycleLimit: number | null;
}

export type CategoryPreview =
  | {
      status: "ok";
      /** Jobs the rules looked at. */
      scanned: number;
      /** True when `limits.preview_time_budget_ms` ran out before all the loaded jobs were looked at. */
      truncated: boolean;
      /** Of those, jobs with at least one hit of the category. */
      hits: number;
      samples: CategoryPreviewSample[];
      /** Null when the save does not change what the AI looks for. */
      review: ReviewEstimate | null;
    }
  /** The draft does not pass the checks of a save (the errors of this category first). */
  | { status: "invalid"; fieldErrors: VocabularyFieldError[] }
  /** No such category in the draft, or the request is malformed. */
  | { status: "invalidPayload" }
  /** interests.yaml, the market or the database cannot be read. */
  | { status: "unavailable" };

function readInterests(): InterestsConfig | null {
  try {
    return reloadConfig("interests");
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

function perCycleLimit(): number | null {
  try {
    return reloadConfig("ai").per_cycle_limit;
  } catch {
    return null;
  }
}

export interface PreviewOptions {
  /** Clock in milliseconds (tests). */
  now?: () => number;
  /** Where the rules run on each job (default `vmTimeBox`, which interrupts a running expression). */
  timeBox?: TimeBox;
}

/** Run the preview for an untrusted request. Never throws for bad input. */
export async function previewCategory(raw: unknown, options: PreviewOptions = {}): Promise<CategoryPreview> {
  const now = options.now ?? Date.now;
  const request = categoryPreviewRequestSchema.safeParse(raw);
  if (!request.success) return { status: "invalidPayload" };
  const { draft, categoryId } = request.data;
  const index = draft.categories.findIndex((category) => category.id === categoryId);
  if (index < 0) return { status: "invalidPayload" };

  const current = readInterests();
  if (current === null) return { status: "unavailable" };
  const merged = draftToCandidate(draft, current);
  if (typeof merged === "string") return { status: "invalidPayload" };
  const validated = interestsSchema.safeParse(merged.candidate);
  // the checks of a save, the slow patterns too (`slowPatternErrors`)
  const all = !validated.success || merged.fieldErrors.length > 0 ? [...merged.fieldErrors, ...(validated.success ? [] : toFieldErrors(validated.error, merged.draftPath))] : slowPatternErrors(validated.data, merged.draftPath);
  if (!validated.success || all.length > 0) {
    const own = `categories.${index}`;
    return { status: "invalid", fieldErrors: [...all.filter((e) => e.path === own || e.path.startsWith(`${own}.`)), ...all.filter((e) => !(e.path === own || e.path.startsWith(`${own}.`)))] };
  }
  const next = validated.data;
  const category = next.signals.categories.find((entry) => entry.id === categoryId);
  if (!category) return { status: "invalidPayload" };

  let pipeline;
  try {
    pipeline = loadPipeline();
  } catch {
    return { status: "unavailable" };
  }
  // only this category: its hits are not cut by the others, and the rules of the others do not run
  const single = { signals: { ...next.signals, categories: [category] }, limits: next.limits };
  const timeBox = options.timeBox ?? vmTimeBox;
  try {
    const db = getDb();
    const jobs = await listRecentJobsForPreview(db, next.limits.preview_jobs);
    let hits = 0;
    let scanned = 0;
    let truncated = false;
    const samples: CategoryPreviewSample[] = [];
    // compiled (and probed) once, outside the time box of a job
    const guard = signalPatternGuard(signalProbeLimits(pipeline), log, timeBox);
    compileSignalRules(single, guard);
    // the draft's patterns run in the web process: each job in a time box that ends at the budget, so one slow
    // expression cannot hold the process past it
    const deadline = now() + next.limits.preview_time_budget_ms;
    for (const job of jobs) {
      const left = deadline - now();
      let found: RuleCandidate[] = [];
      if (left <= 0 || !timeBox(() => (found = findCandidates(job.description, single, pipeline, guard)), left)) {
        truncated = true;
        break;
      }
      scanned += 1;
      const first = found.find((candidate) => candidate.tier === category.id);
      if (first === undefined) continue;
      hits += 1;
      if (samples.length < PREVIEW_SAMPLES) samples.push({ jobId: job.id, title: job.title, quote: first.quote });
    }
    return { status: "ok", scanned, truncated, hits, samples, review: await estimateReview(current, next) };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * What saving `next` over `current` costs in AI reviews: nothing when the signals prompt version stays; else the jobs
 * the `signals` step would select with the new version (same conditions as `listJobsToReview`) and the cycles that takes.
 */
export async function estimateReview(current: InterestsConfig, next: InterestsConfig): Promise<ReviewEstimate | null> {
  const spec = signalsPrompt(next);
  if (spec === null || spec.version === (signalsPrompt(current)?.version ?? null)) return null;
  const jobs = await countJobsToReview(getDb(), { promptVersion: spec.version, withoutCandidates: next.limits.ai_review_without_candidates });
  const limit = perCycleLimit();
  return { jobs, rounds: limit === null ? null : Math.ceil(jobs / limit), perCycleLimit: limit };
}
