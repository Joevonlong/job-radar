import { AiProviderError, AiUnavailableError, QUOTA_GUARD_CODE as QUOTA_GUARD, quotaGuardResume, sanitize } from "@/lib/ai/errors";
import { buildScorePrompt, scoreOutputSchemaFor, scorePromptFor, summariesOfAnswer, type ScoreLanguage, type ScoreOutput, type ScoreOutputLanguages, type ScorePromptJob } from "@/lib/ai/prompts/score";
import { aiOutputLanguages } from "@/lib/i18n/config";
import { createDefaultProviders } from "@/lib/ai/providers";
import { createDbHealthStore } from "@/lib/ai/health";
import { createDbQuotaStore } from "@/lib/ai/quota-guard";
import { createAiRouter, type AiRouter } from "@/lib/ai/router";
import { registerAiSubtask, skipSubtask, type AiSubtaskContext, type SkippedSubtask } from "@/lib/ai/step";
import { createDbUsageStore } from "@/lib/ai/usage";
import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig, type AiConfig, type PipelineConfig } from "@/lib/config";
import { loadPipeline, MarketUnresolvedError } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import { countScoreBacklog, countUnscoredJobs, listScoreCandidates, listScoreQueue, markScoresStaleByPromptVersion, saveScore, type ScoreCandidate } from "@/lib/db/repos/scores";
import { asGermanLevel, parseLocations, parseSalary } from "@/lib/db/queries/parse";
import { parseFilterReason } from "@/lib/filter/reasons";
import { cleanDescriptionsForAi } from "@/lib/traps/clean";

import { languagePenalty, resolveGermanLevel } from "./german";
import { recheckGerman } from "./german-recheck";
import { currentPreferencesSnapshotId, missingProfileFields, readScoringProfile, type ProfileScoringField, type ScoringProfile } from "./profile";
import { createPriorityScorer, orderByPriority, type PriorityBreakdown } from "./priority";
import { computeRankValue, finalMatchScore } from "./rank";

/** Name of the AI sub-task in the `ai` cycle step. */
export const SCORE_SUBTASK_NAME = "score";

/** `stopped` / skip reason when me.yaml has neither a summary nor skills. */
export const PROFILE_INCOMPLETE = "profile_incomplete";

/** `stopped` when the market cannot be resolved: nothing is scored or re-settled this round. */
export const MARKET_UNRESOLVED = "market_unresolved";

/** The local language the scoring prompt asks about: null when the market's language step is off. */
export function scoreLanguageOf(pipeline: Pick<PipelineConfig, "market" | "language">): ScoreLanguage | null {
  const code = pipeline.market.language?.code;
  const requirement = pipeline.language.requirement;
  if (code === undefined || requirement === null) return null;
  return { name: new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code, examples: requirement.prompt_examples };
}

/** Failure samples kept in the step result. */
const MAX_FAILURE_SAMPLES = 10;
const MAX_REASON_CHARS = 300;

export interface ScoringDeps {
  db: Db;
  router: AiRouter;
  config: AiConfig;
  logger: ChannelLogger;
  now: () => Date;
  signal?: AbortSignal;
  /** Where the profile comes from (default: the YAML files on disk). Tests inject one. */
  loadProfile?: () => Promise<ScoringProfile>;
  /** interests.yaml `bonus_cap` (default: the config file). */
  loadBonusCap?: () => number;
  /** Terms of search.yaml `keyword_groups` for the title match of the priority (default: the config file). */
  loadSearchTerms?: () => string[];
  /** pipeline.yaml, for the city spellings of the priority (default: the config file). */
  loadPipeline?: () => PipelineConfig;
  /** The languages the AI writes in (default: language.yaml `ai.output` / `ai.summary_also`). */
  loadOutputLanguages?: () => ScoreOutputLanguages;
}

export interface ScoringOptions {
  /** At most this many postings (the cycle's `per_cycle_limit`). */
  limit: number;
  /** `stale`: re-score stale scores only (the "rescore N" control); `new`: only jobs that never had a score (the backlog control). */
  only?: "stale" | "new";
  /** Only these jobs (the "score these jobs" control); the ones that need no score are skipped. */
  jobIds?: readonly number[];
}

export interface ScoringFailure {
  jobId: number;
  reason: string;
}

export interface ScoringResult {
  /** Postings picked for this run. */
  candidates: number;
  /** Requested job ids that did not need a score (filtered out, closed, already scored, unknown). */
  skipped: number;
  scored: number;
  /** The jobs scored in this run with their new rank value (for what follows a score, e.g. the translation). */
  scoredJobs: Array<{ jobId: number; rankValue: number | null }>;
  failed: number;
  /** Scores marked stale at the start because the prompt version changed. */
  staleByPromptVersion: number;
  /** Current scores whose German level / deduction was settled again at the start (the job's rule level changed). */
  germanRechecked: number;
  /** Postings still waiting after this run. */
  backlog: { unscored: number; stale: number };
  /** Postings scored per provider. */
  providers: Record<string, number>;
  /** Why the run stopped early or did not start: `profile_incomplete`, `market_unresolved`, `ai_unavailable`, `quota_guard`, `cancelled`. */
  stopped?: string;
  /** With `stopped: "quota_guard"`: when the usage cap is expected to let the AI work again (ISO; null = the next cycle). */
  quotaResumeAt?: string | null;
  /** With `stopped: "quota_guard"`: the picked jobs the cap left unscored (not every unscored job: `per_cycle_limit` leaves some too). */
  quotaHeldJobIds?: number[];
  /** With `stopped: "profile_incomplete"`: the me.yaml fields to fill in (at least one of them). */
  profileMissing?: ProfileScoringField[];
  failures: ScoringFailure[];
}

function describe(error: unknown): string {
  if (error instanceof Error) return sanitize(`${error.name}: ${error.message}`).slice(0, MAX_REASON_CHARS);
  return "unknown error";
}

/**
 * A failure that belongs to one posting (every provider answered, but not with a valid score): the
 * next postings may still work. Anything else (no provider, auth, rate limit, timeout, network) will
 * hit the next posting the same way, so the run stops instead of spending the whole limit on it.
 */
function isPostingSpecific(error: unknown): boolean {
  if (!(error instanceof AiUnavailableError)) return false;
  const failed = error.attempts.filter((a) => a.outcome === "failed");
  return failed.length > 0 && failed.every((a) => a.kind === "invalid_output");
}

/** `description`: the JD as the AI may read it (`jdForAi`; the stored JD itself when the job has no AI traps). */
function toPromptJob(candidate: ScoreCandidate, description: string | null): ScorePromptJob {
  return {
    title: candidate.title,
    company: candidate.company,
    locations: [...new Set(parseLocations(candidate.locationsJson).map((l) => l.label))],
    workplace: candidate.workplace,
    seniority: candidate.seniority,
    contract: candidate.contract,
    salary: parseSalary(candidate.salaryJson)?.raw ?? null,
    description,
  };
}

const clean = (items: readonly string[], max: number): string[] => items.map((s) => s.trim()).filter((s) => s !== "").slice(0, max);

/** Score one posting and store it. Throws on provider or database failure. */
async function scoreCandidate(
  deps: ScoringDeps,
  ctx: { profile: ScoringProfile; snapshotId: number; bonusCap: number; forAi: ReadonlyMap<number, string | null>; pipeline: PipelineConfig; language: ScoreLanguage | null; promptVersion: string; output: ScoreOutputLanguages },
  candidate: ScoreCandidate,
): Promise<{ provider: string; rankValue: number | null }> {
  const { config } = deps;
  const prompt = buildScorePrompt({
    me: ctx.profile.me,
    preferences: ctx.profile.preferences,
    job: toPromptJob(candidate, ctx.forAi.has(candidate.jobId) ? (ctx.forAi.get(candidate.jobId) ?? null) : candidate.description),
    jdMaxChars: config.scoring.jd_max_chars,
    jdHeadShare: config.scoring.jd_head_share,
    glossary: config.translation.glossary,
    language: ctx.language,
    currency: ctx.pipeline.market.currency,
    output: ctx.output,
    criteria: config.scoring.criteria,
  });
  const result = await deps.router.run("score", prompt, scoreOutputSchemaFor(ctx.output), { jobId: candidate.jobId, ...(deps.signal ? { signal: deps.signal } : {}) });
  const output: ScoreOutput = result.value;

  const german = resolveGermanLevel({ rule: asGermanLevel(candidate.germanLevelRule), ai: output.german_level_required, jdText: candidate.description ?? "", pipeline: ctx.pipeline });
  const penalty = languagePenalty(german.level, ctx.profile.me, config.scoring.language_penalty, ctx.pipeline.market.language?.code ?? null);
  const score = finalMatchScore(output.score, penalty);
  const signalBonus = candidate.existing.signalBonus;
  const rankValue = computeRankValue(score, signalBonus, ctx.bonusCap);

  await saveScore(deps.db, {
    jobId: candidate.jobId,
    rowId: candidate.existing.id,
    profileSnapshotId: ctx.snapshotId,
    provider: result.provider,
    model: result.model,
    aiScore: output.score,
    germanPenalty: penalty,
    score,
    signalBonus,
    rankValue,
    fitReasons: clean(output.fit_reasons, 4),
    gaps: clean(output.gaps, 3),
    summaries: summariesOfAnswer(output, ctx.output),
    outputLang: ctx.output.language,
    germanLevel: german.level,
    germanLevelAi: output.german_level_required,
    germanLevelSource: german.source,
    promptVersion: ctx.promptVersion,
  });
  if (german.source !== "agree" && german.source !== "rule" && german.source !== "ai") {
    deps.logger.info("german level differs between rule and AI", {
      jobId: candidate.jobId,
      rule: candidate.germanLevelRule,
      ai: output.german_level_required,
      used: german.level,
      source: german.source,
    });
  }
  deps.logger.info("job scored", { jobId: candidate.jobId, provider: result.provider, aiScore: output.score, germanPenalty: penalty, score });
  return { provider: result.provider, rankValue };
}

/** Filter notes that mean "could not place the posting" for the priority's location part. */
const UNCLEAR_LOCATION_NOTES: ReadonlySet<string> = new Set(["remote_scope_unknown", "location_unknown"]);

export type QueuedJob = { jobId: number; title: string; company: string; firstSeenAt: Date; hasScore: boolean; breakdown: PriorityBreakdown };

/**
 * The jobs that need a score, in the order the AI should get them: never-scored jobs before stale
 * re-scores (a profile change must not starve new postings), and inside each group by the cheap
 * relevance pre-score of ai.yaml `scoring.priority` (title, signals, location, seniority, recency),
 * so the most relevant postings are scored first and not just the newest.
 */
export async function buildScoreQueue(
  deps: ScoringDeps,
  profile: ScoringProfile,
  snapshotId: number,
  options: Pick<ScoringOptions, "only" | "jobIds"> = {},
  pipelineConfig?: PipelineConfig,
): Promise<QueuedJob[]> {
  const all = await listScoreQueue(deps.db, { snapshotId, ...(options.only === "stale" ? { only: "stale" as const } : {}), ...(options.jobIds ? { jobIds: options.jobIds } : {}) });
  const items = options.only === "new" ? all.filter((item) => !item.hasScore) : all;
  const bonusCap = (deps.loadBonusCap ?? (() => loadConfig("interests").bonus_cap))();
  const keywordGroupTerms = (deps.loadSearchTerms ?? (() => Object.values(loadConfig("search").keyword_groups).flat()))();
  const pipeline = pipelineConfig ?? (deps.loadPipeline ?? loadPipeline)();
  const scorer = createPriorityScorer({
    priority: deps.config.scoring.priority,
    languagePenalty: deps.config.scoring.language_penalty,
    preferences: profile.preferences,
    keywordGroupTerms,
    pipeline,
    bonusCap,
    me: profile.me,
    now: deps.now(),
  });
  const ranked = orderByPriority(items, (item) =>
    scorer({
      title: item.title,
      locations: parseLocations(item.locationsJson),
      workplace: item.workplace === "onsite" || item.workplace === "hybrid" || item.workplace === "remote" ? item.workplace : "unknown",
      seniority: item.seniority,
      germanLevel: asGermanLevel(item.germanLevelRule),
      // only notes that say the filter could not place the posting; "only the country" and "the JD says it hires in Germany" are in scope
      locationUnclear: item.filterReasons.some((reason) => UNCLEAR_LOCATION_NOTES.has(parseFilterReason(reason).code ?? "")),
      countryLevel: item.filterReasons.some((reason) => parseFilterReason(reason).code === "location_country_level"),
      signalBonus: item.signalBonus,
      postedAt: item.postedAt,
      firstSeenAt: item.firstSeenAt,
    }),
  ).map((item) => ({ jobId: item.jobId, title: item.title, company: item.company, firstSeenAt: item.firstSeenAt, hasScore: item.hasScore, breakdown: item.breakdown }));
  return [...ranked.filter((item) => !item.hasScore), ...ranked.filter((item) => item.hasScore)];
}

/** The full rows (with the JD) of the picked jobs, in the order they were picked. */
async function loadInOrder(deps: ScoringDeps, snapshotId: number, jobIds: readonly number[]): Promise<ScoreCandidate[]> {
  if (jobIds.length === 0) return [];
  const rows = await listScoreCandidates(deps.db, { snapshotId, limit: jobIds.length, jobIds });
  const byId = new Map(rows.map((row) => [row.jobId, row]));
  return jobIds.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The scoring run: mark scores of an older prompt version stale, take up to
 * `limit` jobs that need a score (new ones first, most relevant first by the pre-score; then stale ones), have the AI score
 * each against the profile, apply the German deduction in code, and store score, reasons, gaps,
 * summaries and the rank value. A posting whose answer stays invalid after the router's retries and
 * fallbacks is skipped and tried again next time; if no provider works at all the run stops.
 */
export async function runScoring(deps: ScoringDeps, options: ScoringOptions): Promise<ScoringResult> {
  const result: ScoringResult = {
    candidates: 0,
    skipped: 0,
    scored: 0,
    scoredJobs: [],
    failed: 0,
    staleByPromptVersion: 0,
    germanRechecked: 0,
    backlog: { unscored: 0, stale: 0 },
    providers: {},
    failures: [],
  };
  const finish = async (): Promise<ScoringResult> => {
    result.backlog = snapshotId === null ? result.backlog : await countScoreBacklog(deps.db, snapshotId);
    return result;
  };
  let snapshotId: number | null = null;

  // The prompt (and its version) depends on the market's local language; without a market nothing is touched
  let pipeline: PipelineConfig;
  try {
    pipeline = (deps.loadPipeline ?? loadPipeline)();
  } catch (error) {
    if (!(error instanceof MarketUnresolvedError)) throw error;
    result.stopped = MARKET_UNRESOLVED;
    deps.logger.warn("scoring skipped: the market cannot be resolved", { reason: error.reason });
    return result;
  }
  const language = scoreLanguageOf(pipeline);
  // The output language is not part of the version (no re-scoring on a language change); the criteria are
  const output = (deps.loadOutputLanguages ?? aiOutputLanguages)();
  const promptVersion = scorePromptFor(language, { output, criteria: deps.config.scoring.criteria }).version;
  result.staleByPromptVersion = await markScoresStaleByPromptVersion(deps.db, promptVersion);

  const profile = await (deps.loadProfile ?? readScoringProfile)();
  const missing = missingProfileFields(profile.me);
  if (missing.length > 0) {
    result.stopped = PROFILE_INCOMPLETE;
    result.profileMissing = missing;
    // The backlog still counts, so the caller can say how many jobs wait for the profile.
    result.backlog.unscored = await countUnscoredJobs(deps.db);
    deps.logger.warn("scoring skipped: me.yaml has neither a summary nor skills", { missing });
    return finish();
  }
  snapshotId = await currentPreferencesSnapshotId(deps.db, profile);
  const bonusCap = (deps.loadBonusCap ?? (() => loadConfig("interests").bonus_cap))();
  result.germanRechecked = (await recheckGerman(deps.db, { me: profile.me, penalties: deps.config.scoring.language_penalty, bonusCap, pipeline })).updated;
  if (result.germanRechecked > 0) deps.logger.info("german level of scored jobs settled again", { updated: result.germanRechecked });

  const ordered = await buildScoreQueue(deps, profile, snapshotId, options, pipeline);
  const picked = ordered.slice(0, Math.max(0, options.limit)).map((item) => item.jobId);
  if (options.jobIds) result.skipped = new Set(options.jobIds).size - ordered.length;
  const candidates = await loadInOrder(deps, snapshotId, picked);
  result.candidates = candidates.length;
  // Hidden text and instructions to the AI are taken out of the JD the model reads (the German check below keeps the real JD)
  const forAi = await cleanDescriptionsForAi(deps.db, candidates.map((c) => ({ jobId: c.jobId, description: c.description })), { logger: deps.logger });
  const ctx = { profile, snapshotId, bonusCap, forAi, pipeline, language, promptVersion, output };

  let next = 0;
  // the candidates that got an answer or a failure of their own (the rest is what the usage cap held back, if it stopped the run)
  const tried = new Set<number>();
  const worker = async (): Promise<void> => {
    while (result.stopped === undefined && !deps.signal?.aborted) {
      const candidate = candidates[next++];
      if (candidate === undefined) return;
      try {
        const { provider, rankValue } = await scoreCandidate(deps, ctx, candidate);
        tried.add(candidate.jobId);
        result.scored += 1;
        result.scoredJobs.push({ jobId: candidate.jobId, rankValue });
        result.providers[provider] = (result.providers[provider] ?? 0) + 1;
      } catch (error) {
        if (error instanceof AiProviderError && error.kind === "aborted") {
          result.stopped = "cancelled";
          return;
        }
        // Job Radar's usage cap held the AI back: not a failure of this posting; the rest waits for the next cycle
        const capped = quotaGuardResume(error);
        if (capped) {
          result.stopped ??= QUOTA_GUARD;
          if (result.stopped === QUOTA_GUARD) result.quotaResumeAt = capped.resumeAt;
          deps.logger.warn("scoring paused: Job Radar's AI usage cap reached", { jobId: candidate.jobId, resumeAt: capped.resumeAt });
          return;
        }
        tried.add(candidate.jobId);
        result.failed += 1;
        const reason = describe(error);
        if (result.failures.length < MAX_FAILURE_SAMPLES) result.failures.push({ jobId: candidate.jobId, reason });
        deps.logger.warn("job could not be scored", { jobId: candidate.jobId, reason });
        if (error instanceof AiUnavailableError && !isPostingSpecific(error)) result.stopped = "ai_unavailable";
      }
    }
  };
  const workers = Math.max(1, Math.min(deps.config.scoring.concurrency, candidates.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (result.stopped === QUOTA_GUARD) result.quotaHeldJobIds = candidates.filter((c) => !tried.has(c.jobId)).map((c) => c.jobId);
  if (result.stopped === undefined && deps.signal?.aborted) result.stopped = "cancelled";
  return finish();
}

/**
 * The "rescore N" control of /settings (its `rescore_stale` handler calls this): re-score
 * stale scores now, up to `limit` (default: the cycle limit of ai.yaml). Stale scores are also picked
 * up by every cycle, after new postings, so this only makes them go first.
 */
export async function rescoreStale(deps: ScoringDeps, options: { limit?: number } = {}): Promise<ScoringResult> {
  return runScoring(deps, { limit: options.limit ?? deps.config.per_cycle_limit, only: "stale" });
}

/**
 * The "score the backlog" control (`score_jobs` with `backlog`): score the waiting jobs that never had a
 * score, most relevant first, up to `scoring.backlog_per_run` of ai.yaml (the cycle's `per_cycle_limit`
 * is a different budget). Stale re-scores are not part of it ("rescore N" does those).
 */
export async function scoreBacklog(deps: ScoringDeps, options: { limit?: number } = {}): Promise<ScoringResult> {
  return runScoring(deps, { limit: options.limit ?? deps.config.scoring.backlog_per_run, only: "new" });
}

/** The "score these jobs" control (`score_jobs` with job ids): exactly the jobs the user picked, whatever the limits. */
export async function scoreJobs(deps: ScoringDeps, jobIds: readonly number[]): Promise<ScoringResult> {
  const ids = [...new Set(jobIds)];
  return runScoring(deps, { limit: ids.length, jobIds: ids });
}

/** Router + logger wiring for callers outside a cycle (the runner's control handler). */
export function createScoringDeps(input: { db: Db; logger: ChannelLogger; timeZone: string; signal?: AbortSignal; now?: () => Date; config?: AiConfig }): ScoringDeps {
  const config = input.config ?? loadConfig("ai");
  const now = input.now ?? (() => new Date());
  return {
    db: input.db,
    config,
    logger: input.logger,
    now,
    ...(input.signal ? { signal: input.signal } : {}),
    // a request the user made: the shared cooldowns and the usage cap's window apply, the per-cycle cap does not
    router: createAiRouter({
      config,
      providers: createDefaultProviders(config, { logger: input.logger }),
      usage: createDbUsageStore(input.db),
      health: createDbHealthStore(input.db),
      quota: createDbQuotaStore(input.db),
      origin: "control",
      timeZone: input.timeZone,
      now,
      logger: input.logger,
    }),
  };
}

/** The `score` sub-task of the `ai` step. Does nothing in a dry run (no database, no AI calls). */
export async function scoreSubtask(ctx: AiSubtaskContext): Promise<ScoringResult | { skipped: string } | SkippedSubtask<ScoringResult>> {
  const db = ctx.cycle.db;
  if (ctx.cycle.dryRun || db === null) return { skipped: "dry run" };
  const result = await runScoring(
    { db, router: ctx.router, config: ctx.config, logger: ctx.cycle.logger, now: ctx.cycle.now, signal: ctx.cycle.signal },
    { limit: ctx.perCycleLimit },
  );
  // No market, nothing scored: the step fails visibly (fail-closed, the doctor says why)
  if (result.stopped === MARKET_UNRESOLVED) throw new Error("scoring skipped: the market cannot be resolved (see pnpm run doctor)");
  // Every posting failed: the step must show the failure instead of an "ok" with a zero.
  if (result.scored === 0 && result.failed > 0) {
    throw new Error(`scoring failed for all ${result.failed} posting(s): ${result.failures[0]?.reason ?? "unknown"}`);
  }
  // Nothing was scored because the profile is empty: the step records it as skipped with the reason, not as "ok".
  if (result.stopped === PROFILE_INCOMPLETE) return skipSubtask(PROFILE_INCOMPLETE, result);
  // Nothing was scored because the usage cap holds the AI back: skipped with the reason (the push says how many wait).
  if (result.stopped === QUOTA_GUARD && result.scored === 0) return skipSubtask(QUOTA_GUARD, result);
  return result;
}

export function registerScoringSubtask(): void {
  registerAiSubtask({ name: SCORE_SUBTASK_NAME, run: scoreSubtask });
}
