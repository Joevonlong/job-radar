import { maintainCurrentScores } from "@/lib/cycle/current-scores";
import { noopSpan, type SpanHandle } from "@/lib/activity";
import { createHttpClient } from "@/lib/channels/http";
import { createPublicOnlyFetch, sharedPublicOnlyFetch } from "@/lib/net/public-fetch";
import type { ChannelRegistry } from "@/lib/channels/registry";
import type { ChannelLogger } from "@/lib/channels/types";
import { loadCompanies, loadConfig, type PipelineConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { getCompanyById, getCompanyByNameNorm, getOrCreateCompany, listCompaniesWithAliases, type Company } from "@/lib/db/repos/companies";
import { bestOtherPriority, getJobSourceByRawPosting, upsertJobSource } from "@/lib/db/repos/job-sources";
import { getJob, insertJob, statusWhenSeenAgain, updateJob, type Job } from "@/lib/db/repos/jobs";
import { listPendingRawPostings, lockPendingRawPosting, markRawParseFailed, markRawParsed, type RawPosting } from "@/lib/db/repos/raw-postings";
import type { CycleStepContext, StepResult } from "@/lib/cycle/steps";
import { registerCycleStep } from "@/lib/cycle/steps";
import { refreshSalaryBenchmark, type BenchmarkRefreshResult } from "@/lib/salary/benchmark";
import { loadBaseCurrency } from "@/lib/signals/floor";

import { buildStoredAliasIndex, resolveCompanyName, type ResolvedCompanyName } from "./company";
import { syncCompanyDisplayNames } from "./company-names";
import { applyMerge, fieldsOf, fieldsOfJob, findMatchingJob, sourceWins, type MatchKind } from "./dedupe";
import { refreshIdentityKeysIfStale, splitMergedJobs, type IdentityKeyRefreshResult, type SplitMergedResult } from "./identity-keys";
import { runMaintenance, type MaintenanceResult } from "./lifecycle";
import { refreshSalariesIfStale, type SalaryRefreshResult } from "./refresh-salary";
import type { NormalizedJob } from "./normalize";
import { describeError, MAX_REASON_CHARS, parseAndNormalize } from "./prepare";
import { dormancyReady } from "@/lib/db/repos/dormancy";
import { backfillChangeFingerprints } from "@/lib/db/repos/change-fingerprints";

export { normalizeCompanyKey, resolveCompanyName } from "./company";
export { runMaintenance, type MaintenanceResult } from "./lifecycle";
export { normalizeDraft, normalizeTitle, type NormalizedJob } from "./normalize";
export { refreshSalaries, refreshSalariesIfStale, salaryFingerprint, type SalaryRefreshResult } from "./refresh-salary";
export { refreshIdentityKeys, refreshIdentityKeysIfStale, type IdentityKeyRefreshResult, type SplitMergedResult } from "./identity-keys";

/** Failure samples listed in the step result. */
const MAX_FAILURE_SAMPLES = 10;

export interface PipelineOptions {
  activity?: SpanHandle;
  relist: { minGapDays: number };
  config: PipelineConfig;
  registry: ChannelRegistry;
  logger: ChannelLogger;
  signal?: AbortSignal;
}

/**
 * The relist rule for replaying stored postings (`pnpm reprocess`): they are observations already counted, not new ones,
 * so the replay keeps last listed up to date but never records a relist.
 */
export const REPLAY_RELIST: PipelineOptions["relist"] = { minGapDays: 0 };

export interface PipelineFailureSample {
  rawPostingId: number;
  channelId: string;
  reason: string;
}

export interface PipelineResult {
  /** Pending postings looked at. */
  processed: number;
  /** Postings that now are `parsed`. */
  parsed: number;
  /** New jobs. */
  created: number;
  /** Postings folded into an existing job found by this rule. */
  merged: Record<MatchKind, number>;
  /** Of the new jobs, those the SimHash pass held apart from a job with another title that the old rule would have joined. Not merges, and not in `merged`. */
  titleGuard: { blocked: number };
  /** Re-parsed postings (their payload changed) that updated the job they already belonged to. */
  updated: number;
  relisted: number;
  /** Postings marked `parse_failed` (reason stored in `raw_postings.parse_error`). */
  parseFailed: number;
  /** Postings left `pending` because storing the result failed (retried next cycle). */
  deferred: number;
  aborted: boolean;
  failures: PipelineFailureSample[];
}

type Outcome =
  | { kind: "skipped" }
  | { kind: "created"; blockedByTitle: boolean }
  | { kind: "merged"; by: MatchKind; relisted?: boolean }
  | { kind: "updated"; relisted?: boolean }
  | { kind: "parse_failed"; reason: string };

/** The posting's own location texts joined ("Berlin, Germany; Munich, Germany"); null when it names none. */
function sourceLocationLabel(locations: NormalizedJob["locations"]): string | null {
  const labels = [...new Set(locations.map((l) => l.label.trim()).filter((l) => l !== ""))];
  return labels.length === 0 ? null : labels.join("; ").slice(0, 300);
}

/**
 * The company row of a posting: the row of its own key; without one, the company that stores this key as an alias (a spelling
 * that was merged away must not grow a new row); else a new row.
 */
export async function companyOfPosting(tx: Executor, resolved: ResolvedCompanyName, aliasTargets: ReadonlyMap<string, number>): Promise<Company> {
  const targetId = aliasTargets.get(resolved.nameNorm);
  if (targetId !== undefined && (await getCompanyByNameNorm(tx, resolved.nameNorm)) === null) {
    const target = await getCompanyById(tx, targetId);
    if (target) return target;
  }
  return getOrCreateCompany(tx, resolved);
}

/** Match or create the job, then link the posting to it and mark the posting parsed. One transaction. */
async function persist(db: Db, raw: RawPosting, normalized: NormalizedJob, family: string, options: PipelineOptions, aliasTargets: ReadonlyMap<string, number>): Promise<Outcome> {
  const { config } = options;
  const priority = config.apply_priority[family as keyof PipelineConfig["apply_priority"]];
  return db.transaction(async (tx): Promise<Outcome> => {
    if (!(await lockPendingRawPosting(tx, raw))) return { kind: "skipped" };
    const company = await companyOfPosting(tx, resolveCompanyName(normalized.companyName, config), aliasTargets);
    const existingSource = await getJobSourceByRawPosting(tx, raw.id);

    let job: Job | null = existingSource ? await getJob(tx, existingSource.jobId) : null;
    let outcome: Outcome = { kind: "updated" };
    let blockedByTitle = false;
    if (!job) {
      const found = await findMatchingJob(
        tx,
        { normalized, companyId: company.id, companyName: normalized.companyName, companyKey: company.nameNorm, channelFamily: family, externalId: raw.externalId, rawPostingId: raw.id },
        config,
      );
      blockedByTitle = found.blockedByTitle;
      if (found.match) {
        job = found.match.job;
        outcome = { kind: "merged", by: found.match.kind };
      }
    }

    const incoming = fieldsOf(normalized);
    let jobId: number;
    if (!job) {
      const created = await insertJob(tx, {
        companyId: company.id,
        title: incoming.title,
        titleNorm: incoming.titleNorm,
        locationsJson: incoming.locationsJson,
        workplace: incoming.workplace,
        seniority: incoming.seniority,
        contract: incoming.contract,
        salaryJson: incoming.salaryJson,
        description: incoming.description,
        language: incoming.language,
        germanLevelRequired: incoming.germanLevelRequired,
        postedAt: incoming.postedAt,
        firstSeenAt: raw.fetchedAt,
        lastListedAt: raw.fetchedAt,
        lastSeenAt: raw.fetchedAt,
        simhash: incoming.simhash,
        isAgency: incoming.isAgency,
        skills: incoming.skills,
      });
      jobId = created.id;
      outcome = { kind: "created", blockedByTitle };
    } else {
      const otherBest = await bestOtherPriority(tx, job.id, raw.id);
      const merged = applyMerge(fieldsOfJob(job), incoming, sourceWins(priority, otherBest), company.id);
      const seenAgain = raw.fetchedAt.getTime() > job.lastSeenAt.getTime();
      const relisted = await updateJob(
        tx,
        job.id,
        {
          ...merged,
          ...(seenAgain ? { lastSeenAt: raw.fetchedAt, status: statusWhenSeenAgain(job), ...(await dormancyReady(tx) ? { dormantAt: null } : {}) } : {}),
        },
        { observedAt: raw.fetchedAt, observedRunId: raw.runId, minGapDays: options.relist.minGapDays },
      );
      if (outcome.kind === "merged" || outcome.kind === "updated") outcome = { ...outcome, relisted };
      jobId = job.id;
    }

    await upsertJobSource(tx, {
      jobId,
      rawPostingId: raw.id,
      channelId: raw.channelId,
      url: normalized.sourceUrl ?? raw.url ?? normalized.applyUrl,
      applyUrl: normalized.applyUrl !== null && normalized.applyUrl !== (normalized.sourceUrl ?? raw.url) ? normalized.applyUrl : null,
      locationLabel: sourceLocationLabel(normalized.locations),
      priority,
      firstSeenAt: existingSource?.firstSeenAt ?? raw.fetchedAt,
    });
    await markRawParsed(tx, raw.id);
    return outcome;
  });
}

/**
 * The `pipeline` step: every `pending` raw posting → the channel's `parse` → draft validation →
 * normalization → match an existing job (same source, exact company + title + city key, SimHash) or
 * create one → `job_sources` → raw marked `parsed`. A posting that cannot be parsed is marked
 * `parse_failed` with its reason and the rest carry on; a posting whose result cannot be
 * stored stays `pending` for the next cycle.
 */
export async function runPipeline(db: Db, options: PipelineOptions): Promise<PipelineResult> {
  const result: PipelineResult = {
    processed: 0,
    parsed: 0,
    created: 0,
    merged: { same_source: 0, exact_key: 0, simhash: 0 },
    titleGuard: { blocked: 0 },
    updated: 0,
    relisted: 0,
    parseFailed: 0,
    deferred: 0,
    aborted: false,
    failures: [],
  };
  const { logger } = options;
  const activity = options.activity ?? noopSpan;
  const note = (raw: RawPosting, reason: string): void => {
    if (result.failures.length < MAX_FAILURE_SAMPLES) result.failures.push({ rawPostingId: raw.id, channelId: raw.channelId, reason });
  };

  // merges and this step both run under the cycle lock, so the index cannot go stale during the run
  const aliasIndex = buildStoredAliasIndex(await listCompaniesWithAliases(db), options.config.company.legal_suffixes);
  for (const { key, companyIds } of aliasIndex.ambiguous) logger.warn("the stored aliases of several companies give one key; it is not redirected", { key, companyIds });

  let afterId = 0;
  for (;;) {
    const batch = await listPendingRawPostings(db, { afterId, limit: options.config.batch_size });
    if (batch.length === 0) break;
    for (const raw of batch) {
      if (options.signal?.aborted) {
        result.aborted = true;
        return result;
      }
      afterId = raw.id;
      result.processed += 1;

      try {
        const prepared = parseAndNormalize(raw, options);
        if (!prepared.ok) {
          result.parseFailed += 1;
          activity.item("parse_failed", { rawPostingId: raw.id });
          note(raw, prepared.reason);
          logger.warn("raw posting could not be parsed", { rawPostingId: raw.id, channel: raw.channelId, reason: prepared.reason });
          try {
            await markRawParseFailed(db, raw.id, prepared.reason);
          } catch (error) {
            result.deferred += 1;
            logger.error("could not record the parse failure", { rawPostingId: raw.id, error: describeError(error) });
          }
          continue;
        }

        try {
          const outcome = await persist(db, raw, prepared.normalized, prepared.family, options, aliasIndex.targets);
          if (outcome.kind === "skipped") continue;
          if ((outcome.kind === "merged" || outcome.kind === "updated") && outcome.relisted) result.relisted += 1;
          result.parsed += 1;
          if (outcome.kind === "created") {
            result.created += 1;
            if (outcome.blockedByTitle) result.titleGuard.blocked += 1;
          }
          else if (outcome.kind === "merged") result.merged[outcome.by] += 1;
          else result.updated += 1;
        } catch (error) {
          result.deferred += 1;
          note(raw, `not stored: ${describeError(error)}`);
          logger.error("raw posting could not be stored; it stays pending", { rawPostingId: raw.id, channel: raw.channelId, error: describeError(error) });
        }
      } finally { activity.progress(result.processed); }
    }
  }
  return result;
}

// ---------------------------------------------------------------- cycle steps

function requireDb(ctx: CycleStepContext): Db {
  if (!ctx.db) throw new Error("this cycle step needs a database");
  return ctx.db;
}

/**
 * Re-read the stored salaries with the current parsing (once per salary parsing, see `refreshSalariesIfStale`):
 * raw postings the pipeline already parsed are not parsed again unless their payload changes, so a
 * parsing fix would otherwise never reach the jobs it was made for.
 */
export async function refreshStoredSalaries(db: Db, options: Omit<PipelineOptions, "relist"> & { force?: boolean }): Promise<SalaryRefreshResult | null> {
  return refreshSalariesIfStale(db, {
    config: options.config,
    logger: options.logger,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.force ? { force: true } : {}),
    salaryOf: (raw) => {
      const prepared = parseAndNormalize(raw, options);
      return prepared.ok ? prepared.normalized.salary : undefined;
    },
  });
}

/** `ok`: the stored keys are current (`result` null: nothing was due). Not `ok`: the recompute failed or was stopped. */
export type IdentityKeyRefresh = { ok: true; result: IdentityKeyRefreshResult | null } | { ok: false; error: string };

/**
 * Recompute the stored company and title keys once per key version (see `refreshIdentityKeysIfStale`), before any posting is
 * matched with the new keys. Never throws: a failure is logged and returned, and the caller must not file postings then.
 */
export async function refreshStoredIdentityKeys(db: Db, options: Pick<PipelineOptions, "config" | "logger" | "signal"> & { force?: boolean }): Promise<IdentityKeyRefresh> {
  try {
    const result = await refreshIdentityKeysIfStale(db, {
      config: options.config,
      logger: options.logger,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.force ? { force: true } : {}),
    });
    return result?.aborted ? { ok: false, error: "aborted" } : { ok: true, result };
  } catch (error) {
    options.logger.warn("company and title keys could not be recomputed", { error: describeError(error) });
    return { ok: false, error: describeError(error).slice(0, MAX_REASON_CHARS) };
  }
}

/** `splitMergedJobs` with the pipeline's own reading of each raw posting (`pnpm reprocess --split-merged`). */
export async function splitMergedJobsOf(db: Db, options: Omit<PipelineOptions, "relist">): Promise<SplitMergedResult> {
  return splitMergedJobs(db, {
    config: options.config,
    logger: options.logger,
    ...(options.signal ? { signal: options.signal } : {}),
    identityOf: (raw) => {
      const prepared = parseAndNormalize(raw, options);
      if (!prepared.ok) return undefined;
      const { companyName, title, locations } = prepared.normalized;
      return { companyName, title, locations, cities: locations.flatMap((location) => (location.city ? [location.city] : [])) };
    },
  });
}

export async function pipelineStep(ctx: CycleStepContext): Promise<StepResult> {
  const db = requireDb(ctx);
  // Filing with the new keys against a table that still holds old ones would create companies and jobs next to the stored
  // ones, and such duplicates are never merged afterwards. So when the keys cannot be brought up to date, nothing is filed:
  // the postings stay `pending` (stored), the step fails visibly, and the next cycle tries again.
  const keys = await refreshStoredIdentityKeys(db, { config: loadPipeline(), logger: ctx.logger, signal: ctx.signal });
  if (!keys.ok) return { status: "failed", result: { identityKeys: { error: keys.error }, filed: 0 } };
  // the display names of config/sources.yaml (ats_boards) reach companies that were created before a name was corrected
  try {
    const names = await syncCompanyDisplayNames(db, { companies: loadCompanies().companies, pipeline: loadPipeline() });
    if (names.renamed > 0 || names.merged > 0) ctx.logger.info("company display names updated", { ...names });
  } catch (error) {
    ctx.logger.warn("company display names could not be updated", { error: describeError(error) });
  }
  const options: PipelineOptions = { relist: { minGapDays: loadConfig("jobArchive").relist.min_gap_days }, config: loadPipeline(), registry: ctx.channels.registry, logger: ctx.logger, signal: ctx.signal };
  const result = await runPipeline(db, { ...options, activity: ctx.activity });
  const salaryRefresh = await refreshStoredSalaries(db, options);
  const salaryBenchmark = await rebuildSalaryBenchmark(db, ctx.logger);
  ctx.logger.info("pipeline done", { processed: result.processed, created: result.created, blockedByTitle: result.titleGuard.blocked, parseFailed: result.parseFailed, deferred: result.deferred, salariesChanged: salaryRefresh?.changed ?? 0 });
  const withRefresh = salaryRefresh ? { ...result, salaryRefresh } : result;
  return { status: result.deferred > 0 ? "partial" : "ok", result: salaryBenchmark ? { ...withRefresh, salaryBenchmark } : withRefresh };
}

/** Rebuild the salary benchmark from the salaries just stored. Never fails the step: a problem is only logged. */
async function rebuildSalaryBenchmark(db: Db, logger: ChannelLogger): Promise<BenchmarkRefreshResult | null> {
  try {
    const currency = loadBaseCurrency();
    if (currency === null) return null;
    return await refreshSalaryBenchmark(db, { config: loadConfig("salary"), currency, logger });
  } catch (error) {
    logger.warn("salary benchmark could not be rebuilt", { error: describeError(error) });
    return null;
  }
}

/** `ui.yaml: job_checks.closed_recheck`; when ui.yaml does not read, the recheck is skipped this run (the rest of the step runs). */
function readClosedRecheck(logger: CycleStepContext["logger"]): { enabled: boolean; extra_phrases: readonly string[] } {
  try {
    return loadConfig("ui").job_checks.closed_recheck;
  } catch (error) {
    logger.warn("ui.yaml unreadable: watched postings not rechecked", { error: error instanceof Error ? error.message : String(error) });
    return { enabled: false, extra_phrases: [] };
  }
}

export async function maintenanceStep(ctx: CycleStepContext): Promise<StepResult> {
  const config = loadPipeline();
  // The link check and the recheck request URLs that came from data: connections go to public addresses only, checked
  // when the socket connects. Tests inject their own fetch, or a resolver (then this run gets its own pool, closed after
  // it); otherwise one shared pool serves every run.
  const { fetch: injected, resolveHost } = ctx.channels.runtime;
  const ownFetch = injected === undefined && resolveHost !== undefined ? createPublicOnlyFetch({ resolve: resolveHost }) : null;
  const http = createHttpClient({
    settings: { timeoutMs: config.lifecycle.link_check_timeout_ms, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
    signal: ctx.signal,
    logger: ctx.logger,
    fetch: injected ?? ownFetch ?? sharedPublicOnlyFetch(),
  });
  // The recheck of watched jobs is switched in ui.yaml (the user's file), its rates are in pipeline.yaml
  const checks = readClosedRecheck(ctx.logger);
  try {
    const result: MaintenanceResult = await runMaintenance(requireDb(ctx), {
      config,
      relist: { minGapDays: loadConfig("jobArchive").relist.min_gap_days },
      http,
      logger: ctx.logger,
      signal: ctx.signal,
      now: ctx.now,
      watched: { enabled: checks.enabled, extraPhrases: checks.extra_phrases },
      ...(resolveHost ? { resolveHost } : {}),
    });
    const fingerprints = ctx.signal.aborted ? undefined : await backfillChangeFingerprints(requireDb(ctx), config.batch_size);
    const currentScores = ctx.signal.aborted ? undefined : await maintainCurrentScores(requireDb(ctx), ctx.activity);
    return { result: { ...result, fingerprints, currentScores } };
  } finally {
    await ownFetch?.close();
  }
}

/** Plug `pipeline` and `maintenance` into the processing cycle (called once at start-up). */
export function registerPipelineSteps(): void {
  registerCycleStep("pipeline", pipelineStep);
  registerCycleStep("maintenance", maintenanceStep);
}
