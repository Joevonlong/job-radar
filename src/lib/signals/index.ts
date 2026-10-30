import { scoreTransaction } from "@/lib/db/repos/current-scores";
import { activityErrorCode, noopSpan, type ItemEventCode } from "@/lib/activity";
import type { SpanHandle } from "@/lib/activity/types";
import { createHash } from "node:crypto";

import { AiProviderError, AiUnavailableError, type AiRouter } from "@/lib/ai";
import { QUOTA_GUARD_CODE, quotaGuardResume } from "@/lib/ai/errors";
import { buildSignalsPrompt } from "@/lib/ai/prompts/signals";
import { registerAiSubtask, type AiSubtaskContext } from "@/lib/ai/step";
import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig, type InterestsConfig, type PipelineConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { CycleStepContext, StepResult } from "@/lib/cycle/steps";
import { registerCycleStep } from "@/lib/cycle/steps";
import type { Db } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { parseSalary } from "@/lib/db/queries/parse";
import {
  listBonusRows,
  listJobsToReview,
  listJobsToScan,
  listJobsToSyncSalary,
  listAmountSignals,
  listSignalsOfJob,
  replaceSalarySignals,
  saveAiReview,
  saveRuleScan,
  setScoreBonuses,
  type ScoreBonusUpdate,
  setSignalValue,
} from "@/lib/db/repos/signals";
import { listRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";

import { computeRankValue } from "@/lib/scoring/rank";
import { cleanDescriptionsForAi, loadTrapSpans, overlapsTrap, type TrapSpan } from "@/lib/traps";
import { runTrapScanStep } from "@/lib/traps/cycle";
import { runGhostCheckStep } from "@/lib/ghost/step";
import { runVisaScanStep } from "@/lib/visa/step";

import { revalueAmount } from "./amount";
import { bonusPolicy, signalBonus } from "./bonus";
import { buildCatalog } from "./catalog";
import { rulesFingerprint, signalsPrompt } from "./fingerprint";
import { loadBaseCurrency, loadSalaryFloor } from "./floor";
import { signalPatternGuard, withinJobBudget } from "./pattern-guard";
import { mergeAiReview, numberCandidates, toPromptCandidates, type ReviewStats } from "./review";
import { compileSignalRules, findCandidates, type RuleCandidate, type SignalPatternGuard, type SlowSignalPattern } from "./rules";
import { isSalaryDerived, salaryDraft, withSalarySignal } from "./salary-signal";
import { signalAmountSchema, type SignalDraft } from "./types";

export { annualEurTop, bonusPolicy, highValuePolicy, isHighPayAmount, isHighPaySignal, isHighValueSignal, otherRegionOfAmount, signalBonus, type BonusBreakdown, type BonusPolicy } from "./bonus";
export { buildCatalog, categoryLabel, toCategoryView, toCategoryViews, type CategoryView, type SignalCatalog } from "./catalog";
export { promptCategories, rulesFingerprint, signalsPrompt } from "./fingerprint";
export { loadBaseCurrency, loadBonusPolicy, loadHighValuePolicy, loadSalaryFloor, loadSignalCatalog } from "./floor";
export { findCandidates, findQuoteTerm, type RuleCandidate, type SignalPatternGuard, type SlowSignalPattern } from "./rules";
export { sharedSignalPatternGuard, signalPatternGuard, signalPatternIsFast, withinJobBudget, type SignalProbeLimits } from "./pattern-guard";
export { mergeAiReview } from "./review";
export { locateQuote, sentenceAround } from "./quote";
export { isSalaryDerived, salaryDraft, withSalarySignal } from "./salary-signal";
export * from "./types";

const md5 = (text: string): string => createHash("md5").update(text, "utf8").digest("hex");

/** Bump when `revalueAmount` changes in a way the config does not show (2: base currency figures). */
const VALUATION_VERSION = 2;

/** Key of the state row that remembers which valuation settings the stored amounts were worked out with. */
export const VALUATION_FINGERPRINT_KEY = "signals:valuation_fingerprint";

/** Hash of the settings `revalueAmount` reads (pipeline.yaml `salary`: periods, rates, local currencies, other-region phrases; the base currency). */
export function valuationFingerprint(pipeline: PipelineConfig): string {
  const { periods_per_year, fx_pivot, fx_rates, local_currencies, other_region_patterns } = pipeline.salary;
  return createHash("sha256")
    .update(JSON.stringify({ version: VALUATION_VERSION, periods_per_year, fx_pivot, fx_rates, local_currencies, other_region_patterns, currency: pipeline.market.currency }))
    .digest("hex")
    .slice(0, 32);
}

export interface RevalueResult {
  /** Amount signals looked at. */
  checked: number;
  updated: number;
}

/**
 * Work every stored amount out again with the current rates, local currencies and other-region phrases
 * (`revalueAmount`), rule and AI signals alike, without a rescan or a new AI review. Runs when those settings
 * changed since the last run (or with `force`); null when nothing had to be done (or there is no amount category).
 */
export async function revalueSignals(db: Db, options: { interests: InterestsConfig; pipeline: PipelineConfig; batchSize: number; force?: boolean; signal?: AbortSignal }): Promise<RevalueResult | null> {
  const amountId = buildCatalog(options.interests).amount?.id;
  if (amountId === undefined) return null;
  const fingerprint = valuationFingerprint(options.pipeline);
  const [row] = await listRuntimeState(db, VALUATION_FINGERPRINT_KEY);
  if (!options.force && row?.value === fingerprint) return null;
  const result: RevalueResult = { checked: 0, updated: 0 };
  let afterId = 0;
  for (;;) {
    if (options.signal?.aborted) return result; // the fingerprint is not stored: the next run starts over
    const batch = await listAmountSignals(db, { amountId, afterId, limit: options.batchSize });
    if (batch.length === 0) break;
    for (const stored of batch) {
      afterId = stored.id;
      result.checked += 1;
      const parsed = signalAmountSchema.safeParse(stored.value);
      if (!parsed.success) continue;
      const fresh = revalueAmount(parsed.data, options.pipeline, stored.description);
      if (JSON.stringify(fresh) === JSON.stringify(parsed.data)) continue;
      await setSignalValue(db, stored.id, fresh);
      result.updated += 1;
    }
  }
  await setRuntimeState(db, VALUATION_FINGERPRINT_KEY, fingerprint);
  return result;
}

/** The signals the rule stage stores: everything except candidates that wait for the AI. */
export function ruleDrafts(candidates: readonly RuleCandidate[]): SignalDraft[] {
  return candidates
    .filter((c) => !c.aiConfirmOnly)
    .map((c) => ({ tier: c.tier, kind: c.kind, value: c.value, quote: c.quote, quoteOffset: c.quoteOffset, quoteSource: "description" as const, extractor: "rule" as const }));
}

// ---------------------------------------------------------------- rule scan

export interface RuleScanResult {
  scanned: number;
  /** Jobs that got at least one signal. */
  withSignals: number;
  signals: number;
  /** Jobs whose scan could not be stored (retried next cycle). */
  failed: number;
  aborted: boolean;
}

export interface RuleScanOptions {
  interests: InterestsConfig;
  pipeline: PipelineConfig;
  logger: ChannelLogger;
  signal?: AbortSignal;
  /** Jobs per database page (pipeline.yaml `batch_size`). */
  batchSize: number;
  /** The AI-trap spans of the jobs (default: the stored findings); a candidate there is not stored. */
  loadTrapSpans?: (db: Db, jobs: ReadonlyArray<{ jobId: number; description: string }>) => Promise<Map<number, TrapSpan[]>>;
}

/** Rule candidates whose hit lies in hidden text or an instruction to an AI are dropped (a hidden "€200k" makes no T1). */
export function withoutTrapCandidates(candidates: RuleCandidate[], spans: readonly TrapSpan[] | undefined): RuleCandidate[] {
  if (!spans || spans.length === 0) return candidates;
  return candidates.filter((c) => !overlapsTrap(c.hit.start, c.hit.end - c.hit.start, spans));
}

/**
 * The rule part of the `signals` step: every job whose JD or vocabulary changed since its last scan
 * gets its candidates found (no AI), and the rule signals stored with their quotes (C7).
 */
export async function runRuleScan(db: Db, options: RuleScanOptions): Promise<RuleScanResult> {
  const { interests, pipeline, logger } = options;
  const result: RuleScanResult = { scanned: 0, withSignals: 0, signals: 0, failed: 0, aborted: false };
  const activeIds = buildCatalog(interests).categories.map((category) => category.id);
  // a user pattern too slow on the probe's test texts is left out of this run, with a warning; the jobs scanned without it
  // carry a rules hash of their own, so they are scanned again once it runs
  const left: SlowSignalPattern[] = [];
  const warned = signalPatternGuard(interests.limits, logger);
  const guard: SignalPatternGuard = {
    isFast: warned.isFast,
    onSlow: (slow) => {
      left.push(slow);
      warned.onSlow?.(slow);
    },
  };
  compileSignalRules(interests, guard);
  const fingerprint = rulesFingerprint(interests, pipeline);
  const rulesHash = left.length === 0 ? fingerprint : md5(JSON.stringify([fingerprint, left.map((slow) => [slow.categoryId, slow.field, slow.index])]));
  let afterId = 0;
  for (;;) {
    const batch = await listJobsToScan(db, { rulesHash, afterId, limit: options.batchSize });
    if (batch.length === 0) break;
    const trapSpans = await (options.loadTrapSpans ?? ((d, jobs) => loadTrapSpans(d, jobs, { logger })))(db, batch.map((j) => ({ jobId: j.id, description: j.description })));
    for (const job of batch) {
      if (options.signal?.aborted) {
        result.aborted = true;
        return result;
      }
      afterId = job.id;
      try {
        // the backstop for a pattern the probe let through: the rules on one JD stop at limits.pattern_job_ms, the job is
        // not stored as scanned and is tried again in the next cycle
        let found: RuleCandidate[] = [];
        if (!withinJobBudget(() => void (found = findCandidates(job.description, interests, pipeline, guard)), interests.limits)) {
          result.failed += 1;
          logger.warn("signal scan of a job stopped: the interest patterns took longer than limits.pattern_job_ms", { jobId: job.id, ms: interests.limits.pattern_job_ms });
          continue;
        }
        const candidates = withoutTrapCandidates(found, trapSpans.get(job.id));
        const salarySignal = salaryDraft(parseSalary(job.salaryJson), job.description, interests, pipeline);
        const drafts = withSalarySignal(salarySignal, ruleDrafts(candidates));
        await saveRuleScan(db, {
          jobId: job.id,
          descriptionHash: md5(job.description),
          rulesHash,
          salaryHash: job.salaryHash,
          candidateCount: candidates.filter((c) => c.isTag !== true).length,
          activeIds,
          signals: drafts,
        });
        result.scanned += 1;
        result.signals += drafts.length;
        if (drafts.length > 0) result.withSignals += 1;
      } catch (error) {
        result.failed += 1;
        logger.error("signal scan failed for a job", { jobId: job.id, error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown error" });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- salary signal

export interface SalarySyncResult {
  /** Jobs whose salary changed since their signals were made. */
  synced: number;
  /** Salary signals now stored (a salary that is not usable removes the old one). */
  withSalarySignal: number;
  failed: number;
}

/**
 * The amount signal of a salary follows `jobs.salary_json` without a rescan or a new AI review: when the
 * salary changed (a better parser, a better source), the old salary signal and the amounts it makes
 * redundant go, the new one is added. Jobs whose JD changed are left to the rule scan.
 */
export async function syncSalarySignals(db: Executor, options: { interests: InterestsConfig; pipeline: PipelineConfig; logger: ChannelLogger; batchSize: number; signal?: AbortSignal }): Promise<SalarySyncResult> {
  const { interests, pipeline, logger } = options;
  const result: SalarySyncResult = { synced: 0, withSalarySignal: 0, failed: 0 };
  const amountId = buildCatalog(interests).amount?.id ?? null;
  let afterId = 0;
  for (;;) {
    const batch = await listJobsToSyncSalary(db, { afterId, limit: options.batchSize });
    if (batch.length === 0) break;
    for (const job of batch) {
      if (options.signal?.aborted) return result;
      afterId = job.id;
      try {
        const stored = (await listSignalsOfJob(db, job.id)).filter((s) => s.tier === amountId);
        const fresh = salaryDraft(parseSalary(job.salaryJson), job.description, interests, pipeline);
        const mine = stored.filter(isSalaryDerived);
        const others = stored.filter((s) => !isSalaryDerived(s)).map((s) => ({ ...s, value: signalAmountSchema.safeParse(s.value).data ?? null }));
        const keptIds = new Set(withSalarySignal(fresh, others).flatMap((d) => ("id" in d ? [d.id] : [])));
        const deleteIds = [...mine, ...others.filter((s) => !keptIds.has(s.id))].map((s) => s.id);
        await replaceSalarySignals(db, { jobId: job.id, salaryHash: job.salaryHash, deleteIds, insert: fresh });
        result.synced += 1;
        if (fresh) result.withSalarySignal += 1;
      } catch (error) {
        result.failed += 1;
        logger.error("salary signal sync failed for a job", { jobId: job.id, error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown error" });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- score bonus

export interface BonusReconcileResult {
  /** `scores` rows looked at. */
  checked: number;
  updated: number;
}

/**
 * Make `scores.signal_bonus` (and, where the row has a match score, `rank_value` via the
 * `computeRankValue`) of every score row agree with its job's signals, the current category weights / cap in
 * interests.yaml and the salary floor (a stated amount below it brings no bonus; `salaryFloorEur`
 * defaults to preferences.yaml, null = no floor known). Changing the weights therefore only needs the
 * next cycle, no AI. The rows are the hard filter's (one per job and profile snapshot);
 * this never creates one: a job without a row gets its bonus in the cycle after the filter made it.
 */
export async function reconcileBonuses(
  db: Db,
  interests: InterestsConfig,
  salaryFloorEur: number | null = loadSalaryFloor(),
  baseCurrency: string | null = loadBaseCurrency(),
): Promise<BonusReconcileResult> {
  // Without a market no amount can be compared; the stored bonuses stay as they are (fail-closed)
  if (baseCurrency === null) return { checked: 0, updated: 0 };
  const policy = bonusPolicy(interests, salaryFloorEur, baseCurrency);
  const rows = await listBonusRows(db);
  const updates: ScoreBonusUpdate[] = [];
  for (const row of rows) {
    const bonus = signalBonus(row.signals, interests, policy).bonus;
    const rank = row.score.score === null ? row.score.rankValue : computeRankValue(row.score.score, bonus, interests.bonus_cap);
    if (row.score.signalBonus === bonus && row.score.rankValue === rank) continue;
    updates.push({ scoreId: row.score.id, signalBonus: bonus, rankValue: rank });
  }
  await scoreTransaction(db, (tx) => setScoreBonuses(tx, updates));
  return { checked: rows.length, updated: updates.length };
}

// ---------------------------------------------------------------- AI review

export interface AiReviewOptions {
  activity?: SpanHandle;
  router: AiRouter;
  interests: InterestsConfig;
  pipeline: PipelineConfig;
  logger: ChannelLogger;
  /** Jobs this run may send to the AI (ai.yaml `per_cycle_limit`). */
  limit: number;
  signal?: AbortSignal;
  /** Only these jobs (smoke tests and manual runs). */
  jobIds?: readonly number[];
}

export interface AiReviewResult {
  reviewed: number;
  /** Jobs the AI could not answer for (all providers failed or answered invalid output). */
  failed: number;
  /** The JD changed while the AI worked; the next cycle starts over for those. */
  skipped: number;
  /** Stopped early: cancelled, or too many failures in a row. */
  stopped: "cancelled" | "failures" | typeof QUOTA_GUARD_CODE | null;
  stats: ReviewStats;
  providers: Record<string, number>;
  jobs: Array<{ jobId: number; provider: string; model: string; stats: ReviewStats }>;
}

const emptyStats = (): ReviewStats => ({ confirmed: 0, rejected: 0, added: 0, unreviewed: 0, droppedQuote: 0, droppedAmount: 0 });

/**
 * The AI part of the `signals` step: jobs with fresh rule signals that the AI has not reviewed
 * (jobs with candidates first) go to the `signals` task; the answer confirms or rejects every
 * candidate and adds what the vocabulary missed. Every quote is checked against the JD text before
 * it is stored (C7); the final signals replace the job's rule signals.
 */
export async function runAiReview(db: Db, options: AiReviewOptions): Promise<AiReviewResult> {
  const { interests, pipeline, logger } = options;
  const result: AiReviewResult = { reviewed: 0, failed: 0, skipped: 0, stopped: null, stats: emptyStats(), providers: {}, jobs: [] };
  const spec = signalsPrompt(interests);
  // no amount or keyword category: nothing for the AI to review
  if (spec === null) return result;
  const activeIds = buildCatalog(interests).categories.map((category) => category.id);
  const jobs = await listJobsToReview(db, {
    promptVersion: spec.version,
    limit: options.limit,
    withoutCandidates: interests.limits.ai_review_without_candidates,
    ...(options.jobIds ? { jobIds: options.jobIds } : {}),
  });
  let failuresInRow = 0;
  const guard = signalPatternGuard(interests.limits, logger);
  compileSignalRules(interests, guard);
  // The AI reads the JD without hidden text and instructions to an AI; its quotes are still checked against the real JD
  const trapSpans = await loadTrapSpans(db, jobs.map((j) => ({ jobId: j.id, description: j.description })), { logger });
  const forAi = await cleanDescriptionsForAi(db, jobs.map((j) => ({ jobId: j.id, description: j.description })), { logger });
  const activity = options.activity ?? noopSpan;
  let done = 0;
  activity.progress(0, jobs.length);
  for (const job of jobs) {
    if (options.signal?.aborted) {
      result.stopped = "cancelled";
      break;
    }
    let itemCode: ItemEventCode | undefined = "item.ok";
    let errorCode: string | undefined;
    try {
      let found: RuleCandidate[] = [];
      if (!withinJobBudget(() => void (found = findCandidates(job.description, interests, pipeline, guard)), interests.limits)) {
        itemCode = "item.skipped";
        result.skipped += 1;
        logger.warn("signals AI review of a job skipped: the interest patterns took longer than limits.pattern_job_ms", { jobId: job.id, ms: interests.limits.pattern_job_ms });
        continue;
      }
      const candidates = withoutTrapCandidates(found, trapSpans.get(job.id));
      const numbered = numberCandidates(candidates);
      const prompt = buildSignalsPrompt({
        title: job.title,
        description: forAi.get(job.id) ?? job.description,
        candidates: toPromptCandidates(numbered),
        quoteMaxChars: interests.limits.quote_max_chars,
        maxJdChars: interests.limits.ai_max_jd_chars,
        system: spec.system,
      });
      let answer;
      try {
        answer = await options.router.run("signals", prompt, spec.schema, { jobId: job.id, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        if (options.signal?.aborted) {
          itemCode = undefined;
          result.stopped = "cancelled";
          break;
        }
        if (!(error instanceof AiUnavailableError)) throw error;
        // Job Radar's usage cap held the AI back: the remaining jobs wait for a later cycle, nothing failed
        if (quotaGuardResume(error)) {
          itemCode = "item.paused";
          errorCode = "quota_guard";
          result.stopped = QUOTA_GUARD_CODE;
          break;
        }
        itemCode = "item.failed";
        errorCode = activityErrorCode(error);
        result.failed += 1;
        failuresInRow += 1;
        logger.warn("signals AI review failed for a job", { jobId: job.id, error: error.message });
        if (failuresInRow >= interests.limits.ai_stop_after_failures) {
          result.stopped = "failures";
          break;
        }
        continue;
      }
      failuresInRow = 0;
      const merged = mergeAiReview({ description: job.description, candidates: numbered, output: answer.value, interests, pipeline });
      const salarySignal = salaryDraft(parseSalary(job.salaryJson), job.description, interests, pipeline);
      const tags: SignalDraft[] = candidates
        .filter((c) => c.isTag === true)
        .map((c) => ({ tier: c.tier, kind: c.kind, value: null, quote: c.quote, quoteOffset: c.quoteOffset, extractor: "rule" as const }));
      const stored = await saveAiReview(db, {
        jobId: job.id,
        descriptionHash: md5(job.description),
        promptVersion: spec.version,
        activeIds,
        provider: answer.provider,
        model: answer.model,
        signals: [...withSalarySignal(salarySignal, merged.signals), ...tags],
      });
      if (!stored) {
        itemCode = "item.skipped";
        result.skipped += 1;
        continue;
      }
      result.reviewed += 1;
      result.providers[answer.provider] = (result.providers[answer.provider] ?? 0) + 1;
      for (const key of Object.keys(result.stats) as Array<keyof ReviewStats>) result.stats[key] += merged.stats[key];
      result.jobs.push({ jobId: job.id, provider: answer.provider, model: answer.model, stats: merged.stats });
      logger.debug("signals reviewed", { jobId: job.id, provider: answer.provider, ...merged.stats });
    } catch (error) {
      itemCode = error instanceof AiProviderError && error.kind === "aborted" ? undefined : "item.failed";
      errorCode = activityErrorCode(error);
      throw error;
    } finally {
      if (itemCode) {
        activity.item(itemCode, { jobId: job.id, ...(errorCode ? { errorCode } : {}) });
        activity.progress(++done, jobs.length);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- cycle wiring

function requireDb(ctx: { db: Db | null }): Db {
  if (!ctx.db) throw new Error("this cycle step needs a database");
  return ctx.db;
}

/** The `signals` cycle step: rule scan (no AI), then the bonus of every job follows the signals and the weights. */
export async function signalsStep(ctx: CycleStepContext): Promise<StepResult> {
  const db = requireDb(ctx);
  const interests = loadConfig("interests");
  const pipeline = loadPipeline();
  const revalued = await revalueSignals(db, { interests, pipeline, batchSize: pipeline.batch_size, signal: ctx.signal });
  // The AI trap scan first, so the rule signals below already leave out what lies in hidden text; a failure only makes the step partial
  const traps = await runTrapScanStep(ctx, db);
  // The job checks next (trap → visa → ghost), each with its own error boundary; they only mark jobs and never touch a score
  const visa = await runVisaScanStep(ctx, db);
  const ghost = await runGhostCheckStep(ctx, db);
  const scan = await runRuleScan(db, { interests, pipeline, logger: ctx.logger, batchSize: pipeline.batch_size, signal: ctx.signal });
  const salary = scan.aborted ? null : await syncSalarySignals(db, { interests, pipeline, logger: ctx.logger, batchSize: pipeline.batch_size, signal: ctx.signal });
  const bonus = await reconcileBonuses(db, interests);
  ctx.logger.info("signals done", { revalued: revalued?.updated ?? 0, scanned: scan.scanned, withSignals: scan.withSignals, failed: scan.failed, salarySynced: salary?.synced ?? 0, bonusUpdated: bonus.updated });
  return { status: scan.failed > 0 || (salary?.failed ?? 0) > 0 || traps.failed || visa.failed || ghost.failed ? "partial" : "ok", result: { revalued, traps: traps.summary, visa: visa.summary, ghost: ghost.summary, scan, salary, bonus } };
}

/** The `signals` sub-task of the `ai` step. */
export async function signalsAiSubtask(ctx: AiSubtaskContext): Promise<unknown> {
  const db = requireDb(ctx.cycle);
  const interests = loadConfig("interests");
  const pipeline = loadPipeline();
  const review = await runAiReview(db, {
    activity: ctx.activity,
    router: ctx.router,
    interests,
    pipeline,
    logger: ctx.cycle.logger,
    limit: ctx.perCycleLimit,
    signal: ctx.cycle.signal,
  });
  const bonus = await reconcileBonuses(db, interests);
  ctx.cycle.logger.info("signals AI review done", { reviewed: review.reviewed, failed: review.failed, skipped: review.skipped, stopped: review.stopped, ...review.stats });
  // the per-job list is for scripts; the cycle summary keeps the totals
  const { jobs: _jobs, ...summary } = review;
  void _jobs;
  return { ...summary, bonus };
}

/** Plug the rule-based `signals` step into the processing cycle (called once at start-up). */
export function registerSignalsSteps(): void {
  registerCycleStep("signals", signalsStep);
}

/** Plug the `signals` sub-task into the `ai` step (called once at start-up by the runner and `cycle:run`). */
export function registerSignalsAiSubtask(): void {
  registerAiSubtask({ name: "signals", run: signalsAiSubtask });
}
