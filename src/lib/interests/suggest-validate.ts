/**
 * Checking what the AI proposed. The model's answer is a proposal, not a fact: every suggestion has to
 * be backed by evidence that code can verify against the jobs it was given (the quote is in the JD, the job
 * is of that company, the word is in the title or text), and has to be new. Pure: no database, no clock.
 */
import type { InterestsConfig, PreferencesConfig, SuggestConfig } from "@/lib/config";
import { SIGNAL_REGEX_FLAGS } from "@/lib/config/schemas/interests";
import type { SuggestionSourceJob } from "@/lib/db/repos/interest-suggestions";
import { parseLocations } from "@/lib/db/queries/parse";
import { wholeWordPattern } from "@/lib/filter/rules";
import type { SuggestOutput, SuggestReasons } from "@/lib/ai/prompts/suggest";
import { REFERENCE_OUTPUT, summaryLanguages, type ScoreOutputLanguages } from "@/lib/ai/prompts/score";

import {
  dedupeKeyOf,
  normalizeTerm,
  suggestedCategoryId,
  type SuggestionEvidence,
  type SuggestionPayload,
} from "./suggestion";

export const DROP_REASONS = [
  "low_confidence",
  "missing_reason",
  "invalid_term",
  "no_valid_evidence",
  "too_little_evidence",
  "already_listed",
  "not_distinctive",
  "contradicts_liked",
  "duplicate",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface ValidatedSuggestion {
  payload: SuggestionPayload;
  dedupeKey: string;
}

export interface ValidationResult {
  accepted: ValidatedSuggestion[];
  dropped: Partial<Record<DropReason, number>>;
}

export interface ValidationContext {
  positive: readonly SuggestionSourceJob[];
  ignored: readonly SuggestionSourceJob[];
  interests: Pick<InterestsConfig, "signals" | "watched_companies" | "limits">;
  preferences: Pick<PreferencesConfig, "locations" | "exclude_keywords" | "exclude_companies">;
  config: Pick<SuggestConfig, "min_confidence" | "min_evidence" | "max_term_chars">;
  /** The key a company name is matched on (case, legal form and aliases ignored). */
  normalizeCompany: (name: string) => string;
  /** The languages the reasons were asked in (default: the reference, Chinese with English). */
  output?: ScoreOutputLanguages;
  /**
   * The probe of the user's patterns (the server's `signalPatternIsFast`): a pattern it refuses is not used for the
   * "already listed" check, the way the rules leave it out. Absent = every pattern is used.
   */
  isPatternFast?: (pattern: string) => boolean;
}

/** Longest reason kept; the model is asked for one sentence. */
const MAX_REASON_CHARS = 300;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A word, company or city as a plain one-line string: quotes around it and runs of spaces removed. */
export function cleanTerm(text: string, maxChars: number): string | null {
  const value = collapse(text).replace(/^["'“”‘’„«»]+|["'“”‘’„«»]+$/g, "").trim();
  if (value.length < 2 || value.length > maxChars) return null;
  // a line of punctuation or digits is no term
  return /\p{L}/u.test(value) ? value : null;
}

/** Whether `quote` is a verbatim piece of `description` (runs of whitespace count as one). */
export function quoteInText(quote: string, description: string): boolean {
  const needle = collapse(quote);
  return needle !== "" && collapse(description).includes(needle);
}

const containsWord = (text: string, term: string): boolean => wholeWordPattern(term).test(text);

function jobLocationLabels(job: SuggestionSourceJob): string[] {
  return parseLocations(job.locationsJson).flatMap((location) => [location.label, ...(location.city ? [location.city] : [])]);
}

/** The non-empty reasons of an entry by language; null when it gives none. */
function reasonsOf(entry: SuggestReasons, output: ScoreOutputLanguages): { reasons: Record<string, string> } | null {
  const reasons: Record<string, string> = {};
  for (const code of summaryLanguages(output)) {
    const text = collapse(entry[`reason_${code.toLowerCase().replace(/-/g, "_")}`] ?? "").slice(0, MAX_REASON_CHARS);
    if (text !== "") reasons[code] = text;
  }
  return Object.keys(reasons).length === 0 ? null : { reasons };
}

function evidenceOf(job: SuggestionSourceJob, quote?: string): SuggestionEvidence {
  return { jobId: job.jobId, title: job.title, company: job.companyName, ...(quote === undefined ? {} : { quote }) };
}

/** Terms already in interests.yaml: a keyword or tag of a keyword / tag category, or text one of their patterns already matches. */
function listedSignalTerms(interests: ValidationContext["interests"], isPatternFast: (pattern: string) => boolean): { literals: Set<string>; patterns: RegExp[] } {
  const literals = new Set<string>();
  const sources: string[] = [];
  for (const category of interests.signals.categories) {
    if (category.kind === "keyword") {
      for (const word of category.keywords) literals.add(normalizeTerm(word));
      sources.push(...category.patterns);
    } else if (category.kind === "tag") {
      for (const word of category.tags) literals.add(normalizeTerm(word));
      for (const entry of category.tag_patterns) {
        literals.add(normalizeTerm(entry.name));
        sources.push(entry.pattern);
      }
    }
  }
  const patterns: RegExp[] = [];
  for (const source of sources) {
    if (!isPatternFast(source)) continue;
    try {
      patterns.push(new RegExp(source, SIGNAL_REGEX_FLAGS));
    } catch {
      // the config schema rejects such a pattern; never let a bad one stop the check
    }
  }
  return { literals, patterns };
}

type Counter = (reason: DropReason) => void;

/**
 * Turn the model's answer into the suggestions worth storing. Confidence, evidence and novelty are all checked
 * here; the numbers come from the suggest block of schedule.yaml. The accepted ones are sorted by confidence
 * (highest first); a suggestion that repeats an earlier one of the same answer is dropped.
 */
export function validateSuggestions(output: SuggestOutput, context: ValidationContext): ValidationResult {
  const dropped: Partial<Record<DropReason, number>> = {};
  const count: Counter = (reason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const { config } = context;
  const positiveById = new Map(context.positive.map((job) => [job.jobId, job]));
  const ignoredById = new Map(context.ignored.map((job) => [job.jobId, job]));
  const quoteMax = context.interests.limits.quote_max_chars;
  const listed = listedSignalTerms(context.interests, context.isPatternFast ?? (() => true));
  const candidates: ValidatedSuggestion[] = [];

  const push = (payload: SuggestionPayload): void => {
    candidates.push({ payload, dedupeKey: dedupeKeyOf(payload, context.normalizeCompany) });
  };
  /** Confidence and reasons, shared by every kind; null (already counted) when the entry cannot be used. */
  const reasonLanguages = context.output ?? REFERENCE_OUTPUT;
  const common = (entry: SuggestReasons) => {
    if (entry.confidence < config.min_confidence) {
      count("low_confidence");
      return null;
    }
    const reasons = reasonsOf(entry, reasonLanguages);
    if (reasons === null) {
      count("missing_reason");
      return null;
    }
    return { ...reasons, confidence: entry.confidence };
  };
  /** Distinct jobs of `ids` found in `byId`, in the order given. */
  const jobsOf = (ids: readonly number[], byId: ReadonlyMap<number, SuggestionSourceJob>): SuggestionSourceJob[] => {
    const seen = new Set<number>();
    const jobs: SuggestionSourceJob[] = [];
    for (const id of ids) {
      const job = byId.get(id);
      if (job && !seen.has(id)) {
        seen.add(id);
        jobs.push(job);
      }
    }
    return jobs;
  };
  /** A suggestion needs `need` backing jobs; counts the right drop reason otherwise. */
  const enough = (found: number, listedIds: number, need: number): boolean => {
    if (found >= need) return true;
    count(listedIds === 0 || found === 0 ? "no_valid_evidence" : "too_little_evidence");
    return false;
  };

  // ---- signal words: only into an active keyword or tag category (an answer in the old shape, `benefit_tag`, means the first tag category)
  const targets = context.interests.signals.categories.filter((category) => category.kind !== "amount");
  for (const entry of output.signal_words) {
    const shared = common(entry);
    if (!shared) continue;
    const tier = suggestedCategoryId(entry.tier, targets);
    if (tier === null) {
      count("invalid_term");
      continue;
    }
    const term = cleanTerm(entry.term, config.max_term_chars);
    if (term === null) {
      count("invalid_term");
      continue;
    }
    const key = normalizeTerm(term);
    if (listed.literals.has(key) || listed.patterns.some((pattern) => pattern.test(term))) {
      count("already_listed");
      continue;
    }
    const evidence: SuggestionEvidence[] = [];
    const seenJobs = new Set<number>();
    for (const item of entry.evidence) {
      const job = positiveById.get(item.job_id);
      const quote = collapse(item.quote);
      if (!job || seenJobs.has(job.jobId) || quote === "" || quote.length > quoteMax) continue;
      if (!quoteInText(quote, job.description) || !normalizeTerm(quote).includes(key)) continue;
      seenJobs.add(job.jobId);
      evidence.push(evidenceOf(job, quote));
    }
    if (!enough(evidence.length, entry.evidence.length, config.min_evidence.signal_word)) continue;
    // a word as common in the ignored postings as in the liked ones says nothing about what the user likes
    if (context.ignored.length > 0) {
      const pattern = wholeWordPattern(term);
      const liked = context.positive.filter((job) => pattern.test(job.description)).length / context.positive.length;
      const contrast = context.ignored.filter((job) => pattern.test(job.description)).length / context.ignored.length;
      if (contrast >= liked) {
        count("not_distinctive");
        continue;
      }
    }
    push({ kind: "signal_word", tier, term, ...shared, evidence });
  }

  // ---- watched companies
  for (const entry of output.companies) {
    const shared = common(entry);
    if (!shared) continue;
    const name = cleanTerm(entry.company, config.max_term_chars);
    if (name === null) {
      count("invalid_term");
      continue;
    }
    const norm = context.normalizeCompany(name);
    const backing = jobsOf(entry.evidence_job_ids, positiveById).filter((job) => job.companyNorm === norm || context.normalizeCompany(job.companyName) === norm);
    if (!enough(backing.length, entry.evidence_job_ids.length, config.min_evidence.watched_company)) continue;
    if (
      context.interests.watched_companies.some((watched) => context.normalizeCompany(watched) === norm) ||
      context.preferences.exclude_companies.some((excluded) => context.normalizeCompany(excluded) === norm)
    ) {
      count("already_listed");
      continue;
    }
    // the stored name is the one of the database, not the model's spelling
    push({ kind: "watched_company", company: backing[0]?.companyName ?? name, ...shared, evidence: backing.map((job) => evidenceOf(job)) });
  }

  // ---- filters
  for (const entry of output.filters) {
    const shared = common(entry);
    if (!shared) continue;
    const value = cleanTerm(entry.value, config.max_term_chars);
    if (value === null) {
      count("invalid_term");
      continue;
    }
    const key = normalizeTerm(value);
    if (entry.action === "exclude_keyword") {
      if (context.preferences.exclude_keywords.some((word) => normalizeTerm(word) === key)) {
        count("already_listed");
        continue;
      }
      const backing = jobsOf(entry.evidence_job_ids, ignoredById).filter((job) => containsWord(`${job.title}\n${job.description}`, value));
      if (!enough(backing.length, entry.evidence_job_ids.length, config.min_evidence.filter)) continue;
      // the hard filter reads title and description: a word the liked postings contain would remove them too
      if (context.positive.some((job) => containsWord(`${job.title}\n${job.description}`, value))) {
        count("contradicts_liked");
        continue;
      }
      push({ kind: "filter", action: "exclude_keyword", value, ...shared, evidence: backing.map((job) => evidenceOf(job)) });
    } else if (entry.action === "add_location") {
      if (context.preferences.locations.some((place) => normalizeTerm(place) === key)) {
        count("already_listed");
        continue;
      }
      const backing = jobsOf(entry.evidence_job_ids, positiveById).filter((job) => jobLocationLabels(job).some((label) => normalizeTerm(label).includes(key)));
      if (!enough(backing.length, entry.evidence_job_ids.length, config.min_evidence.filter)) continue;
      push({ kind: "filter", action: "add_location", value, ...shared, evidence: backing.map((job) => evidenceOf(job)) });
    } else {
      const norm = context.normalizeCompany(value);
      if (context.preferences.exclude_companies.some((excluded) => context.normalizeCompany(excluded) === norm)) {
        count("already_listed");
        continue;
      }
      const backing = jobsOf(entry.evidence_job_ids, ignoredById).filter((job) => job.companyNorm === norm || context.normalizeCompany(job.companyName) === norm);
      if (!enough(backing.length, entry.evidence_job_ids.length, config.min_evidence.filter)) continue;
      if (context.positive.some((job) => job.companyNorm === norm || context.normalizeCompany(job.companyName) === norm)) {
        count("contradicts_liked");
        continue;
      }
      push({ kind: "filter", action: "exclude_company", value: backing[0]?.companyName ?? value, ...shared, evidence: backing.map((job) => evidenceOf(job)) });
    }
  }

  // ---- the same thing twice in one answer: keep the one the model was surest of
  const best = new Map<string, ValidatedSuggestion>();
  for (const candidate of [...candidates].sort((a, b) => b.payload.confidence - a.payload.confidence)) {
    if (best.has(candidate.dedupeKey)) {
      count("duplicate");
      continue;
    }
    best.set(candidate.dedupeKey, candidate);
  }
  return { accepted: [...best.values()], dropped };
}
