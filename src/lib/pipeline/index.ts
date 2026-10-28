import { ChannelError } from "@/lib/channels/errors";
import { createHttpClient } from "@/lib/channels/http";
import { createPublicOnlyFetch, sharedPublicOnlyFetch } from "@/lib/net/public-fetch";
import type { ChannelRegistry } from "@/lib/channels/registry";
import { normalizedPostingDraftSchema, type ChannelLogger } from "@/lib/channels/types";
import { loadCompanies, loadConfig, type PipelineConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { bestOtherPriority, getJobSourceByRawPosting, upsertJobSource } from "@/lib/db/repos/job-sources";
import { getJob, insertJob, statusWhenSeenAgain, updateJob, type Job } from "@/lib/db/repos/jobs";
import { listPendingRawPostings, lockPendingRawPosting, markRawParseFailed, markRawParsed, type RawPosting } from "@/lib/db/repos/raw-postings";
import type { CycleStepContext, StepResult } from "@/lib/cycle/steps";
import { registerCycleStep } from "@/lib/cycle/steps";
import { refreshSalaryBenchmark, type BenchmarkRefreshResult } from "@/lib/salary/benchmark";
import { loadBaseCurrency } from "@/lib/signals/floor";

import { resolveCompanyName } from "./company";
import { syncCompanyDisplayNames } from "./company-names";
import { fieldsOf, fieldsOfJob, findMatchingJob, mergeJobFields, type MatchKind } from "./dedupe";
import { refreshIdentityKeysIfStale, splitMergedJobs, type IdentityKeyRefreshResult, type SplitMergedResult } from "./identity-keys";
import { runMaintenance, type MaintenanceResult } from "./lifecycle";
import { refreshSalariesIfStale, type SalaryRefreshResult } from "./refresh-salary";
import { normalizeDraft, type NormalizedJob } from "./normalize";
import { dormancyReady } from "@/lib/db/repos/dormancy";

export { normalizeCompanyKey, resolveCompanyName } from "./company";
export { runMaintenance, type MaintenanceResult } from "./lifecycle";
export { normalizeDraft, normalizeTitle, type NormalizedJob } from "./normalize";
export { refreshSalaries, refreshSalariesIfStale, salaryFingerprint, type SalaryRefreshResult } from "./refresh-salary";
export { refreshIdentityKeys, refreshIdentityKeysIfStale, type IdentityKeyRefreshResult, type SplitMergedResult } from "./identity-keys";

/** Longest error text kept in a log line or a result sample. */
const MAX_REASON_CHARS = 300;
/** Failure samples listed in the step result. */
const MAX_FAILURE_SAMPLES = 10;

export interface PipelineOptions {
  config: PipelineConfig;
  registry: ChannelRegistry;
  logger: ChannelLogger;
  signal?: AbortSignal;
}

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
  /** Re-parsed postings (their payload changed) that updated the job they already belonged to. */
  updated: number;
  /** Postings marked `parse_failed` (reason stored in `raw_postings.parse_error`). */
  parseFailed: number;
  /** Postings left `pending` because storing the result failed (retried next cycle). */
  deferred: number;
  aborted: boolean;
  failures: PipelineFailureSample[];
}

function describeError(error: unknown): string {
  if (error instanceof ChannelError) return `${error.code}: ${error.message}`.slice(0, MAX_REASON_CHARS);
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, MAX_REASON_CHARS);
  return "unknown error";
}

/** Draft validation problems as "field: message" lines, without the offending values. */
function describeDraftIssues(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

type Outcome =
  | { kind: "skipped" }
  | { kind: "created" }
  | { kind: "merged"; by: MatchKind }
  | { kind: "updated" }
  | { kind: "parse_failed"; reason: string };

/** Channel `parse` + draft validation + normalization; failures become a reason string. */
function parseAndNormalize(raw: RawPosting, options: PipelineOptions): { ok: true; normalized: NormalizedJob; family: string } | { ok: false; reason: string } {
  const channel = options.registry.get(raw.channelId);
  if (!channel) return { ok: false, reason: `unknown channel "${raw.channelId}" (not registered in this process)` };
  let draft;
  try {
    const parsed = normalizedPostingDraftSchema.safeParse(channel.parse(raw.payloadJson));
    if (!parsed.success) return { ok: false, reason: `invalid draft from ${raw.channelId}: ${describeDraftIssues(parsed.error)}`.slice(0, MAX_REASON_CHARS) };
    draft = parsed.data;
  } catch (error) {
    return { ok: false, reason: `parse failed: ${describeError(error)}`.slice(0, MAX_REASON_CHARS) };
  }
  try {
    return { ok: true, normalized: normalizeDraft(draft, options.config), family: channel.family };
  } catch (error) {
    return { ok: false, reason: `normalize failed: ${describeError(error)}`.slice(0, MAX_REASON_CHARS) };
  }
}

/** The posting's own location texts joined ("Berlin, Germany; Munich, Germany"); null when it names none. */
function sourceLocationLabel(locations: NormalizedJob["locations"]): string | null {
  const labels = [...new Set(locations.map((l) => l.label.trim()).filter((l) => l !== ""))];
  return labels.length === 0 ? null : labels.join("; ").slice(0, 300);
}

/** Match or create the job, then link the posting to it and mark the posting parsed. One transaction. */
async function persist(db: Db, raw: RawPosting, normalized: NormalizedJob, family: string, options: PipelineOptions): Promise<Outcome> {
  const { config } = options;
  const priority = config.apply_priority[family as keyof PipelineConfig["apply_priority"]];
  return db.transaction(async (tx): Promise<Outcome> => {
    if (!(await lockPendingRawPosting(tx, raw))) return { kind: "skipped" };
    const company = await getOrCreateCompany(tx, resolveCompanyName(normalized.companyName, config));
    const existingSource = await getJobSourceByRawPosting(tx, raw.id);

    let job: Job | null = existingSource ? await getJob(tx, existingSource.jobId) : null;
    let outcome: Outcome = { kind: "updated" };
    if (!job) {
      const match = await findMatchingJob(
        tx,
        { normalized, companyId: company.id, companyName: normalized.companyName, channelFamily: family, externalId: raw.externalId, rawPostingId: raw.id },
        config,
      );
      if (match) {
        job = match.job;
        outcome = { kind: "merged", by: match.kind };
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
        lastSeenAt: raw.fetchedAt,
        simhash: incoming.simhash,
        isAgency: incoming.isAgency,
        skills: incoming.skills,
      });
      jobId = created.id;
      outcome = { kind: "created" };
    } else {
      const otherBest = await bestOtherPriority(tx, job.id, raw.id);
      const wins = otherBest === null || priority <= otherBest;
      const merged = mergeJobFields(fieldsOfJob(job), incoming, wins);
      const seenAgain = raw.fetchedAt.getTime() > job.lastSeenAt.getTime();
      await updateJob(tx, job.id, {
        ...merged,
        ...(wins ? { companyId: company.id } : {}),
        ...(seenAgain ? { lastSeenAt: raw.fetchedAt, status: statusWhenSeenAgain(job), ...(await dormancyReady(tx) ? { dormantAt: null } : {}) } : {}),
      });
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
 * `parse_failed` with its reason and the rest carry on (C1, C2); a posting whose result cannot be
 * stored stays `pending` for the next cycle.
 */
export async function runPipeline(db: Db, options: PipelineOptions): Promise<PipelineResult> {
  const result: PipelineResult = {
    processed: 0,
    parsed: 0,
    created: 0,
    merged: { same_source: 0, exact_key: 0, simhash: 0 },
    updated: 0,
    parseFailed: 0,
    deferred: 0,
    aborted: false,
    failures: [],
  };
  const { logger } = options;
  const note = (raw: RawPosting, reason: string): void => {
    if (result.failures.length < MAX_FAILURE_SAMPLES) result.failures.push({ rawPostingId: raw.id, channelId: raw.channelId, reason });
  };

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

      const prepared = parseAndNormalize(raw, options);
      if (!prepared.ok) {
        result.parseFailed += 1;
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
        const outcome = await persist(db, raw, prepared.normalized, prepared.family, options);
        if (outcome.kind === "skipped") continue;
        result.parsed += 1;
        if (outcome.kind === "created") result.created += 1;
        else if (outcome.kind === "merged") result.merged[outcome.by] += 1;
        else result.updated += 1;
      } catch (error) {
        result.deferred += 1;
        note(raw, `not stored: ${describeError(error)}`);
        logger.error("raw posting could not be stored; it stays pending", { rawPostingId: raw.id, channel: raw.channelId, error: describeError(error) });
      }
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
export async function refreshStoredSalaries(db: Db, options: PipelineOptions & { force?: boolean }): Promise<SalaryRefreshResult | null> {
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
export async function splitMergedJobsOf(db: Db, options: PipelineOptions): Promise<SplitMergedResult> {
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
  // the postings stay `pending` (stored, C1), the step fails visibly, and the next cycle tries again.
  const keys = await refreshStoredIdentityKeys(db, { config: loadPipeline(), logger: ctx.logger, signal: ctx.signal });
  if (!keys.ok) return { status: "failed", result: { identityKeys: { error: keys.error }, filed: 0 } };
  // the display names of config/sources.yaml (ats_boards) reach companies that were created before a name was corrected
  try {
    const names = await syncCompanyDisplayNames(db, { companies: loadCompanies().companies, pipeline: loadPipeline() });
    if (names.renamed > 0 || names.merged > 0) ctx.logger.info("company display names updated", { ...names });
  } catch (error) {
    ctx.logger.warn("company display names could not be updated", { error: describeError(error) });
  }
  const options: PipelineOptions = { config: loadPipeline(), registry: ctx.channels.registry, logger: ctx.logger, signal: ctx.signal };
  const result = await runPipeline(db, options);
  const salaryRefresh = await refreshStoredSalaries(db, options);
  const salaryBenchmark = await rebuildSalaryBenchmark(db, ctx.logger);
  ctx.logger.info("pipeline done", { processed: result.processed, created: result.created, parseFailed: result.parseFailed, deferred: result.deferred, salariesChanged: salaryRefresh?.changed ?? 0 });
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
      http,
      logger: ctx.logger,
      signal: ctx.signal,
      now: ctx.now,
      watched: { enabled: checks.enabled, extraPhrases: checks.extra_phrases },
      ...(resolveHost ? { resolveHost } : {}),
    });
    return { result };
  } finally {
    await ownFetch?.close();
  }
}

/** Plug `pipeline` and `maintenance` into the processing cycle (called once at start-up). */
export function registerPipelineSteps(): void {
  registerCycleStep("pipeline", pipelineStep);
  registerCycleStep("maintenance", maintenanceStep);
}
