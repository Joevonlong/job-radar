/**
 * Weekly AI suggestions for the interests list.
 *
 * `runSuggest` reads the jobs the user liked (marked interested, then prepared, applied, interviewed, offered) and
 * ignored in the last weeks, with the current interests.yaml and preferences.yaml, and asks the AI (`suggest` task)
 * for new signal words, watched companies and filters. Nothing the model says is trusted: the answer is checked
 * against the jobs it was given (verbatim quotes, the job is of that company, the word is there ...), duplicates
 * of anything suggested before are dropped, and what is left is stored as `pending`. It never changes a config
 * file; the user approves or rejects each suggestion on /interests (`suggestion-apply.ts`).
 *
 * A plain function of its dependencies, so the weekly schedule, the control request and tests all call it.
 */
import { AiProviderError, sanitize } from "@/lib/ai/errors";
import type { ScoreOutputLanguages } from "@/lib/ai/prompts/score";
import { buildSuggestPrompt, cutDescription, suggestOutputSchemaFor, SUGGEST_PROMPT_VERSION, type SuggestCategory, type SuggestPromptJob } from "@/lib/ai/prompts/suggest";
import { aiOutputLanguages } from "@/lib/i18n/config";
import { createDefaultProviders } from "@/lib/ai/providers";
import { createAiRouter, type AiRouter } from "@/lib/ai/router";
import { createDbUsageStore } from "@/lib/ai/usage";
import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig, type AiConfig, type InterestsConfig, type PipelineConfig, type PreferencesConfig, type SuggestConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import { parseLocations } from "@/lib/db/queries/parse";
import { findExistingDedupeKeys, insertSuggestions, listSuggestionSourceJobs, type SuggestionSourceJob } from "@/lib/db/repos/interest-suggestions";
import { resolveCompanyName } from "@/lib/pipeline/company";
import { cleanDescriptionsForAi } from "@/lib/traps/clean";
import { categoryLabel } from "@/lib/signals/catalog";

import { selectCandidates } from "./suggest-select";
import { sendSuggestionsNotice, type SuggestionsNotice } from "./suggest-notify";
import { validateSuggestions, type DropReason } from "./suggest-validate";
import { suggestionPayloadSchema, type SuggestionPayload } from "./suggestion";

/** The keyword and tag categories a word may go into, with what the AI is told about them and their current words. */
export function suggestCategories(interests: Pick<InterestsConfig, "signals">): SuggestCategory[] {
  return interests.signals.categories.flatMap((category): SuggestCategory[] => {
    if (category.kind === "amount") return [];
    const definition = category.ai_definition ?? `"${categoryLabel(category, "en")}"`;
    const current = category.kind === "keyword" ? category.keywords : [...category.tags, ...category.tag_patterns.map((p) => p.name)];
    return [{ id: category.id, kind: category.kind, definition, current }];
  });
}

const WEEK_MS = 7 * 24 * 3_600_000;
/** The query reads this many times the wanted number of jobs; `selectCandidates` then picks. */
const FETCH_FACTOR = 4;

export interface SuggestDeps {
  db: Db;
  router: AiRouter;
  /** ai.yaml (the JD cut keeps its head share from `scoring`). */
  aiConfig: AiConfig;
  logger: ChannelLogger;
  now: () => Date;
  signal?: AbortSignal;
  /** Defaults: the files on disk. Tests inject their own. */
  loadSuggestConfig?: () => SuggestConfig;
  loadInterests?: () => InterestsConfig;
  loadPreferences?: () => PreferencesConfig;
  loadPipeline?: () => PipelineConfig;
  /** The languages the reasons are written in (default: language.yaml `ai.output` / `ai.summary_also`). */
  loadOutputLanguages?: () => ScoreOutputLanguages;
  /** Tell the user (default: one Telegram message, see suggest-notify.ts). */
  notify?: (payloads: readonly SuggestionPayload[]) => Promise<SuggestionsNotice>;
}

export interface SuggestSummary {
  status: "done" | "skipped";
  /** Why nothing was asked (`status` skipped). */
  skipped?: "too_few_liked_jobs";
  promptVersion: string;
  liked: number;
  ignored: number;
  /** Items the model returned, before the checks. */
  proposed: number;
  /** Items that passed the checks and are new. */
  accepted: number;
  /** Rows stored (a concurrent run may have stored some of them first). */
  stored: number;
  dropped: Partial<Record<DropReason | "seen_before" | "over_limit", number>>;
  provider?: string;
  model?: string;
  notice?: SuggestionsNotice;
}

const sum = (...lists: readonly unknown[][]): number => lists.reduce((total, list) => total + list.length, 0);

function toPromptJob(job: SuggestionSourceJob, config: SuggestConfig, headShare: number): SuggestPromptJob {
  return {
    id: job.jobId,
    title: job.title,
    company: job.companyName,
    status: job.applicationStatus,
    locations: [...new Set(parseLocations(job.locationsJson).map((l) => l.label))],
    description: cutDescription(job.description, config.jd_max_chars, headShare),
  };
}

/** Run one suggestion pass. Throws when no AI provider can answer (the caller reports it); never writes config files. */
export async function runSuggest(deps: SuggestDeps): Promise<SuggestSummary> {
  const config = (deps.loadSuggestConfig ?? (() => loadConfig("schedule").suggest))();
  const interests = (deps.loadInterests ?? (() => loadConfig("interests")))();
  const preferences = (deps.loadPreferences ?? (() => loadConfig("preferences")))();
  const pipeline = (deps.loadPipeline ?? (() => loadPipeline()))();
  const normalizeCompany = (name: string): string => resolveCompanyName(name, pipeline).nameNorm;

  const since = new Date(deps.now().getTime() - config.lookback_weeks * WEEK_MS);
  const [likedRows, ignoredRows] = await Promise.all([
    listSuggestionSourceJobs(deps.db, { statuses: config.positive_statuses, since, limit: config.max_positive_jobs * FETCH_FACTOR }),
    config.max_ignored_jobs > 0 ? listSuggestionSourceJobs(deps.db, { statuses: config.ignored_statuses, since, limit: config.max_ignored_jobs * FETCH_FACTOR }) : Promise.resolve([]),
  ]);
  const selected = selectCandidates([...likedRows, ...ignoredRows], config);
  // The AI reads (and its evidence is checked against) the JDs without hidden text and instructions to an AI
  const forAi = await cleanDescriptionsForAi(deps.db, [...selected.positive, ...selected.ignored].map((job) => ({ jobId: job.jobId, description: job.description })), { logger: deps.logger });
  const withCleanJd = (job: SuggestionSourceJob): SuggestionSourceJob => ({ ...job, description: forAi.get(job.jobId) ?? job.description });
  const positive = selected.positive.map(withCleanJd);
  const ignored = selected.ignored.map(withCleanJd);
  const summary: SuggestSummary = { status: "done", promptVersion: SUGGEST_PROMPT_VERSION, liked: positive.length, ignored: ignored.length, proposed: 0, accepted: 0, stored: 0, dropped: {} };

  if (positive.length < config.min_positive_jobs) {
    deps.logger.info("interest suggestions skipped: too few liked jobs", { liked: positive.length, needed: config.min_positive_jobs, lookbackWeeks: config.lookback_weeks });
    return { ...summary, status: "skipped", skipped: "too_few_liked_jobs" };
  }

  const headShare = deps.aiConfig.scoring.jd_head_share;
  const output = (deps.loadOutputLanguages ?? aiOutputLanguages)();
  const prompt = buildSuggestPrompt({
    output,
    categories: suggestCategories(interests),
    current: { watchedCompanies: interests.watched_companies },
    preferences: {
      targetTitles: preferences.target_titles,
      locations: preferences.locations,
      excludeKeywords: preferences.exclude_keywords,
      excludeCompanies: preferences.exclude_companies,
    },
    liked: positive.map((job) => toPromptJob(job, config, headShare)),
    ignored: ignored.map((job) => toPromptJob(job, config, headShare)),
    quoteMaxChars: interests.limits.quote_max_chars,
    maxTermChars: config.max_term_chars,
    minEvidence: { signalWord: config.min_evidence.signal_word, watchedCompany: config.min_evidence.watched_company, filter: config.min_evidence.filter },
  });

  let answer;
  try {
    // a weekly job with no time pressure: the stronger model reads the postings
    answer = await deps.router.run("suggest", prompt, suggestOutputSchemaFor(output), { strong: true, ...(deps.signal ? { signal: deps.signal } : {}) });
  } catch (error) {
    if (error instanceof AiProviderError && error.kind === "aborted") throw error;
    deps.logger.error("interest suggestions: the AI could not answer", { error: error instanceof Error ? sanitize(`${error.name}: ${error.message}`).slice(0, 300) : "unknown error" });
    throw error;
  }

  const validation = validateSuggestions(answer.value, { positive, ignored, interests, preferences, config, normalizeCompany, output });
  const seen = await findExistingDedupeKeys(deps.db, validation.accepted.map((s) => s.dedupeKey));
  const fresh = validation.accepted.filter((s) => !seen.has(s.dedupeKey));
  const kept = fresh.slice(0, config.max_suggestions);
  const stored = await insertSuggestions(
    deps.db,
    kept.map((s) => ({ kind: s.payload.kind, dedupeKey: s.dedupeKey, payload: s.payload })),
  );

  summary.proposed = sum(answer.value.signal_words, answer.value.companies, answer.value.filters);
  summary.accepted = fresh.length;
  summary.stored = stored.length;
  summary.dropped = { ...validation.dropped };
  if (seen.size > 0 && validation.accepted.length > fresh.length) summary.dropped.seen_before = validation.accepted.length - fresh.length;
  if (fresh.length > kept.length) summary.dropped.over_limit = fresh.length - kept.length;
  summary.provider = answer.provider;
  summary.model = answer.model;

  deps.logger.info("interest suggestions stored", { liked: positive.length, ignored: ignored.length, proposed: summary.proposed, stored: stored.length, provider: answer.provider });
  if (stored.length > 0 && config.notify) {
    const payloads = stored.flatMap((row) => {
      const parsed = suggestionPayloadSchema.safeParse(row.payloadJson);
      return parsed.success ? [parsed.data] : [];
    });
    const notify = deps.notify ?? ((items) => sendSuggestionsNotice({ db: deps.db, logger: deps.logger, payloads: items, now: deps.now }));
    summary.notice = await notify(payloads);
  }
  return summary;
}

/** Router wiring for callers outside a cycle (the control handler): the providers and usage log of ai.yaml. */
export function createSuggestDeps(input: { db: Db; logger: ChannelLogger; timeZone: string; signal?: AbortSignal; now?: () => Date; config?: AiConfig }): SuggestDeps {
  const aiConfig = input.config ?? loadConfig("ai");
  const now = input.now ?? (() => new Date());
  return {
    db: input.db,
    aiConfig,
    logger: input.logger,
    now,
    ...(input.signal ? { signal: input.signal } : {}),
    router: createAiRouter({ config: aiConfig, providers: createDefaultProviders(aiConfig), usage: createDbUsageStore(input.db), timeZone: input.timeZone, now, logger: input.logger }),
  };
}
