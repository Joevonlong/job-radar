/**
 * Interests editing. The only code behind `/interests` and "save view" on `/jobs` that writes
 * `config/interests.yaml`, and always through the shared config mutator (comments are preserved, the file is
 * replaced atomically). Server Actions in `app/interests/actions.ts` are thin wrappers around these
 * functions; everything arriving here is untrusted and validated with zod (C6).
 *
 * Every change re-reads the file first and changes only its own part, so saving the vocabulary never
 * touches views or watched companies and the other way round. File and directory locks serialize all writers.
 */
import { CHANNEL_CONFIG_TABLE, channelSupportsCompanyQueries, isConfiguredChannelId, settingsFromConfig } from "@/lib/channels/registry";
import { logActionFailure } from "@/lib/logging/action-failure";
import { z } from "zod";

import { ConfigError, configErrorKey, interestsSchema, loadConfig, loadCompanies, mutateConfig, type InterestsConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { viewFiltersSchema, type SavedView } from "@/lib/config/schemas/interests";
import { watchedCompanyBoards } from "@/lib/companies/watched-boards";
import { getDb, listCompaniesWithJobCount, suggestCompanies } from "@/lib/db";
import { resolveCompanyName } from "@/lib/pipeline/company";
import { reconcileBonuses, rulesFingerprint, signalsPrompt } from "@/lib/signals";

import { slowPatternErrors } from "./pattern-check";
import { estimateReview } from "./preview";
import { hasViewFilters, slugifyViewId } from "./view-filters";
import { COMPANY_SUGGESTION_LIMIT, type InterestsActionState, type InterestsFormError, type InterestsSection, type RecomputeOutcome, type WatchedCompanyView } from "./types";
import { draftToCandidate, toFieldErrors, vocabularyDraftSchema } from "./vocabulary-draft";

const MAX_VIEW_NAME_CHARS = 60;
export const MAX_COMPANY_NAME_CHARS = 120;

// ---------------------------------------------------------------- plumbing

const saved = (section: InterestsSection, extra: { id?: string; recompute?: RecomputeOutcome } = {}): InterestsActionState => ({ status: "saved", section, nonce: Date.now(), ...extra });
const failed = (section: InterestsSection, formError: InterestsFormError | null, fieldErrors: Extract<InterestsActionState, { status: "error" }>["fieldErrors"] = []): InterestsActionState => ({
  status: "error",
  section,
  nonce: Date.now(),
  formError,
  fieldErrors,
});

const changeError = (error: unknown): InterestsFormError => configErrorKey(error) ?? (error instanceof ConfigError ? "unreadable" : "writeFailed");

type Edit = (current: InterestsConfig) => { next: InterestsConfig; id?: string } | InterestsFormError;

/** Read, edit, validate and write interests.yaml. `edit` returns the new config or the reason it refuses. */
async function change(section: InterestsSection, edit: Edit): Promise<InterestsActionState> {
  const outcome: { error?: InterestsFormError; id?: string } = {};
  try {
    const next = await mutateConfig("interests", (current) => {
      const edited = edit(current);
      if (typeof edited === "string") {
        outcome.error = edited;
        return null;
      }
      outcome.id = edited.id;
      return edited.next;
    });
    return next === null ? failed(section, outcome.error ?? "writeFailed") : saved(section, outcome.id === undefined ? {} : { id: outcome.id });
  } catch (error) {
    logActionFailure(`interests.${section}`, error);
    return failed(section, changeError(error));
  }
}

// ---------------------------------------------------------------- vocabulary

/** Whether the rule stage has to look at the job descriptions again: the vocabulary fingerprint changed (names, colours, weights do not count). */
function rulesChanged(before: InterestsConfig, after: InterestsConfig): boolean {
  try {
    const pipeline = loadPipeline();
    return rulesFingerprint(before, pipeline) !== rulesFingerprint(after, pipeline);
  } catch (error) {
    logActionFailure("rulesChanged", error);
    return JSON.stringify([before.signals, before.limits]) !== JSON.stringify([after.signals, after.limits]);
  }
}

/** Whether the AI prompt version changed (AI definitions, AI categories, `ai_confirm_only`): jobs on the shelf are reviewed again. */
function promptChanged(before: InterestsConfig, after: InterestsConfig): boolean {
  return (signalsPrompt(before)?.version ?? null) !== (signalsPrompt(after)?.version ?? null);
}

/**
 * Bring the bonus and rank value of every score row in line with the new weights and cap, right away
 * and without AI (`reconcileBonuses`, a SQL-only pass). Done here rather than as a request to
 * the runner (control_requests): it needs no runner, no provider and finishes in moments.
 * Re-scanning the descriptions after a word or pattern change is not done here: it replaces the AI-reviewed
 * signals of every job, so it stays with the cycle's `signals` step, which does it by itself because the
 * vocabulary fingerprint changed.
 */
async function recompute(before: InterestsConfig, after: InterestsConfig): Promise<RecomputeOutcome> {
  const rescanPending = rulesChanged(before, after);
  const reviewPending = promptChanged(before, after);
  const reviewEstimate = reviewPending ? await estimateReview(before, after).then((estimate) => (estimate ? { jobs: estimate.jobs, rounds: estimate.rounds } : null), () => null) : null;
  try {
    const result = await reconcileBonuses(getDb(), after);
    return { reconciled: true, checked: result.checked, updated: result.updated, rescanPending, reviewPending, reviewEstimate };
  } catch (error) {
    logActionFailure("recompute", error);
    return { reconciled: false, checked: 0, updated: 0, rescanPending, reviewPending, reviewEstimate };
  }
}

/** Validate an untrusted vocabulary draft, save it and recompute the ranking. Never throws for bad input. */
export async function saveVocabulary(rawDraft: unknown): Promise<InterestsActionState> {
  const draft = vocabularyDraftSchema.safeParse(rawDraft);
  if (!draft.success) return failed("vocabulary", "invalidPayload");
  const outcome: { before?: InterestsConfig; failure?: InterestsActionState } = {};
  let after: InterestsConfig | null;
  try {
    after = await mutateConfig("interests", (current) => {
      outcome.before = current;
      const merged = draftToCandidate(draft.data, current);
      if (typeof merged === "string") {
        outcome.failure = failed("vocabulary", merged);
        return null;
      }
      const { candidate, draftPath, fieldErrors } = merged;
      const validated = interestsSchema.safeParse(candidate);
      if (!validated.success || fieldErrors.length > 0) {
        outcome.failure = failed("vocabulary", null, [...fieldErrors, ...(validated.success ? [] : toFieldErrors(validated.error, draftPath))]);
        return null;
      }
      // a pattern that is too slow on the probe's test texts would be left out of every scan: not saved
      const slow = slowPatternErrors(validated.data, draftPath);
      if (slow.length > 0) {
        outcome.failure = failed("vocabulary", null, slow);
        return null;
      }
      return validated.data;
    });
  } catch (error) {
    logActionFailure("saveVocabulary", error);
    return failed("vocabulary", changeError(error));
  }
  if (after === null || outcome.before === undefined) return outcome.failure ?? failed("vocabulary", "writeFailed");
  return saved("vocabulary", { recompute: await recompute(outcome.before, after) });
}

// ---------------------------------------------------------------- views

const nameSchema = z.string().trim().min(1).max(MAX_VIEW_NAME_CHARS);
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80);

const saveViewSchema = z.strictObject({
  name: z.string(),
  filters: viewFiltersSchema,
  /** Replace the filters of the view that already has this name. */
  overwrite: z.boolean().optional(),
  makeDefault: z.boolean().optional(),
});

/** "Save the current filters as a view" (from /jobs). `rawRequest` is untrusted. */
export async function saveView(rawRequest: unknown): Promise<InterestsActionState> {
  const request = saveViewSchema.safeParse(rawRequest);
  if (!request.success) return failed("views", "invalidPayload");
  const name = nameSchema.safeParse(request.data.name);
  if (!name.success) return failed("views", "invalidName");
  const { filters, overwrite = false, makeDefault = false } = request.data;
  if (!hasViewFilters(filters)) return failed("views", "noFilters");

  return change("views", (current) => {
    const existing = current.views.find((view) => view.name.toLowerCase() === name.data.toLowerCase());
    if (existing && !overwrite) return "nameTaken";
    const id = existing?.id ?? slugifyViewId(name.data, current.views.map((view) => view.id));
    const view: SavedView = { id, name: existing?.name ?? name.data, default: makeDefault || (existing?.default ?? false), filters };
    const base = existing ? current.views.map((v) => (v.id === id ? view : v)) : [...current.views, view];
    const views = view.default ? base.map((v) => (v.id === id ? v : { ...v, default: false })) : base;
    return { next: { ...current, views }, id };
  });
}

const defaultSchema = z.strictObject({ id: idSchema, value: z.boolean() });

/** Make a view the default of the Today page, or (value false) stop it being the default. */
export async function setDefaultView(rawRequest: unknown): Promise<InterestsActionState> {
  const request = defaultSchema.safeParse(rawRequest);
  if (!request.success) return failed("views", "invalidPayload");
  const { id, value } = request.data;
  return change("views", (current) => {
    if (!current.views.some((view) => view.id === id)) return "viewNotFound";
    return { next: { ...current, views: current.views.map((view) => ({ ...view, default: view.id === id ? value : false })) }, id };
  });
}

const renameSchema = z.strictObject({ id: idSchema, name: z.string() });

export async function renameView(rawRequest: unknown): Promise<InterestsActionState> {
  const request = renameSchema.safeParse(rawRequest);
  if (!request.success) return failed("views", "invalidPayload");
  const name = nameSchema.safeParse(request.data.name);
  if (!name.success) return failed("views", "invalidName");
  const { id } = request.data;
  return change("views", (current) => {
    if (!current.views.some((view) => view.id === id)) return "viewNotFound";
    if (current.views.some((view) => view.id !== id && view.name.toLowerCase() === name.data.toLowerCase())) return "nameTaken";
    return { next: { ...current, views: current.views.map((view) => (view.id === id ? { ...view, name: name.data } : view)) }, id };
  });
}

const deleteSchema = z.strictObject({ id: idSchema });

export async function deleteView(rawRequest: unknown): Promise<InterestsActionState> {
  const request = deleteSchema.safeParse(rawRequest);
  if (!request.success) return failed("views", "invalidPayload");
  const { id } = request.data;
  return change("views", (current) => {
    if (!current.views.some((view) => view.id === id)) return "viewNotFound";
    return { next: { ...current, views: current.views.filter((view) => view.id !== id) }, id };
  });
}

// ---------------------------------------------------------------- watched companies

const companySchema = z.strictObject({ name: z.string() });

/** The key a company name is matched on (case, legal form and aliases ignored), same as the push step uses. */
function companyKey(name: string): string {
  try {
    return resolveCompanyName(name, loadPipeline()).nameNorm;
  } catch (error) {
    logActionFailure("companyKey", error);
    return name.trim().toLowerCase();
  }
}

const tidyName = (name: string): string => name.trim().replace(/\s+/g, " ");

export async function addWatchedCompany(rawRequest: unknown): Promise<InterestsActionState> {
  const request = companySchema.safeParse(rawRequest);
  if (!request.success) return failed("watched", "invalidPayload");
  const name = tidyName(request.data.name);
  if (name === "" || name.length > MAX_COMPANY_NAME_CHARS) return failed("watched", "invalidName");
  return change("watched", (current) => {
    const key = companyKey(name);
    if (current.watched_companies.some((existing) => companyKey(existing) === key)) return "alreadyWatched";
    return { next: { ...current, watched_companies: [...current.watched_companies, name] } };
  });
}

export async function removeWatchedCompany(rawRequest: unknown): Promise<InterestsActionState> {
  const request = companySchema.safeParse(rawRequest);
  if (!request.success) return failed("watched", "invalidPayload");
  const name = request.data.name;
  return change("watched", (current) => {
    if (!current.watched_companies.includes(name)) return "watchedNotFound";
    return { next: { ...current, watched_companies: current.watched_companies.filter((existing) => existing !== name) } };
  });
}

const companiesSchema = z.strictObject({ names: z.array(z.string()).min(1).max(1000) });

export async function removeWatchedCompanies(rawRequest: unknown): Promise<InterestsActionState> {
  const request = companiesSchema.safeParse(rawRequest);
  if (!request.success) return failed("watched", "invalidPayload");
  const names = new Set(request.data.names);
  return change("watched", (current) => {
    if (!current.watched_companies.some((existing) => names.has(existing))) return "watchedNotFound";
    return { next: { ...current, watched_companies: current.watched_companies.filter((existing) => !names.has(existing)) } };
  });
}

/** Autocomplete: company names of the database that contain `query`. Never throws (an unreachable database gives no suggestions). */
export async function suggestCompanyNames(rawQuery: unknown): Promise<string[]> {
  const query = z.string().max(100).safeParse(rawQuery);
  if (!query.success) return [];
  try {
    return (await suggestCompanies(getDb(), query.data, COMPANY_SUGGESTION_LIMIT)).map((company) => company.name);
  } catch (error) {
    logActionFailure("suggestCompanyNames", error);
    return [];
  }
}

/** The watched names with the company each one matches in the database, and whether an ATS board carries it. */
export async function describeWatchedCompanies(names: readonly string[]): Promise<WatchedCompanyView[]> {
  let companyQueryChannels = 0;
  try {
    const config = loadConfig("channels");
    if (loadConfig("search").watched_company_queries.enabled) {
      companyQueryChannels = Object.keys(CHANNEL_CONFIG_TABLE).filter(isConfiguredChannelId).filter((id) => channelSupportsCompanyQueries(id) && settingsFromConfig(id, config).enabled && settingsFromConfig(id, config).companyQueries).length;
    }
  } catch (error) { logActionFailure("describeWatchedCompanies", error); }
  const keys = names.map(companyKey);
  let found: Awaited<ReturnType<typeof listCompaniesWithJobCount>> = [];
  try {
    found = await listCompaniesWithJobCount(getDb(), keys);
  } catch (error) {
    logActionFailure("describeWatchedCompanies", error);
    // database unreachable: the list is shown without matches
  }
  const byKey = new Map(found.map((company) => [company.nameNorm, company]));
  // sources.yaml unreadable: say nothing about boards (no hint) rather than claim there are none
  let boardKeys: ReadonlyMap<string, boolean> | null = null;
  try {
    boardKeys = new Map(watchedCompanyBoards(names, loadCompanies().companies, loadPipeline()).map((entry) => [entry.key, entry.hasBoard]));
  } catch (error) {
    logActionFailure("describeWatchedCompanies", error);
    boardKeys = null;
  }
  return names.map((name, index) => {
    const key = keys[index] ?? "";
    const company = byKey.get(key);
    return { name, companyQueryChannels, match: company ? { name: company.name, jobCount: company.jobCount } : null, hasBoard: boardKeys === null ? true : (boardKeys.get(key) ?? false) };
  });
}
