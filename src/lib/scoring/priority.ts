import type { AiConfig, PipelineConfig, PreferencesConfig, MeConfig } from "@/lib/config";
import { foldText, wholeWordPattern } from "@/lib/filter/rules";
import type { GermanLevel, JobLocation } from "@/lib/domain/types";

import { languagePenalty } from "./german";

/**
 * The cheap relevance pre-score: decides which waiting postings the AI scores first. Pure
 * rules over fields the pipeline already extracted (title, locations, seniority, signals, age): no AI,
 * no description parsing. Weights and tables come from ai.yaml `scoring.priority` (C8). Only the
 * order matters; the number is never shown as a score and never stored.
 */

export type PriorityConfig = AiConfig["scoring"]["priority"];

/** What the pre-score reads from a posting. */
export interface PriorityJob {
  title: string;
  locations: readonly JobLocation[];
  workplace: "onsite" | "hybrid" | "remote" | "unknown";
  seniority: string;
  /** The rule-based German level (`jobs.german_level_required`). */
  germanLevel: GermanLevel;
  /** The hard filter kept the job with a note that it could not place the posting (`remote_scope_unknown`, `location_unknown`). */
  locationUnclear?: boolean;
  /** The hard filter kept the job because its location names only the country ("Germany (Remote)", `location_country_level`). */
  countryLevel?: boolean;
  /** The stored signal bonus of the current snapshot's row (0 until the signals step ran). */
  signalBonus: number;
  postedAt: Date | null;
  firstSeenAt: Date;
}

/** Each component 0..1 (`languageGap` 0..1 too, and subtracted), and the weighted sum. */
export interface PriorityBreakdown {
  title: number;
  signals: number;
  location: number;
  seniority: number;
  recency: number;
  languageGap: number;
  priority: number;
}

export interface PriorityInputs {
  priority: PriorityConfig;
  /** ai.yaml `scoring.language_penalty`, for the local-language gap. */
  languagePenalty: AiConfig["scoring"]["language_penalty"];
  preferences: Pick<PreferencesConfig, "target_titles" | "locations"> & Partial<Pick<PreferencesConfig, "seniority">>;
  /** Terms of search.yaml `keyword_groups`, all groups together. */
  keywordGroupTerms: readonly string[];
  pipeline: Pick<PipelineConfig, "filter" | "market">;
  /** interests.yaml `bonus_cap`. */
  bonusCap: number;
  me: Pick<MeConfig, "languages">;
  now: Date;
}

const DAY_MS = 86_400_000;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Lower-case words of a title or term; "KI-Entwickler" -> ["ki", "entwickler"]. */
function words(text: string): string[] {
  return foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

/**
 * A term word is found in a title word when they are equal; a longer term word also matches a longer
 * form of itself ("engineer" in "engineering"). Short words ("ai", "ki", "ml") must match exactly.
 */
function wordMatches(titleWord: string, termWord: string): boolean {
  return titleWord === termWord || (termWord.length > 3 && titleWord.startsWith(termWord));
}

interface Term {
  words: string[];
  /** Weight of a match of this term: 1 for target titles, `keyword_group_factor` for search keywords. */
  factor: number;
}

function hasPhrase(titleWords: readonly string[], term: readonly string[]): boolean {
  for (let start = 0; start + term.length <= titleWords.length; start += 1) {
    if (term.every((word, i) => wordMatches(titleWords[start + i] ?? "", word))) return true;
  }
  return false;
}

/** Title match 0..1: the best term wins (phrase 1, all words `all_words_match`, at least half of the words, one of them not generic: `partial_match` x share). */
function titleScore(title: string, terms: readonly Term[], generic: ReadonlySet<string>, config: PriorityConfig): number {
  const titleWords = words(title);
  let best = 0;
  for (const term of terms) {
    if (term.words.length === 0) continue;
    let match = 0;
    if (hasPhrase(titleWords, term.words)) {
      match = 1;
    } else {
      const found = term.words.filter((word) => titleWords.some((tw) => wordMatches(tw, word)));
      const share = found.length / term.words.length;
      if (share === 1) match = config.all_words_match;
      else if (share >= 0.5 && found.some((word) => !generic.has(word))) match = config.partial_match * share;
    }
    best = Math.max(best, match * term.factor);
  }
  return clamp01(best);
}

interface LocationMatcher {
  /** The market's home country: a target city is only there (or where no country is stated). */
  homeCountry: string;
  exact: ReadonlySet<string>;
  nearby: ReadonlySet<string>;
  exactLabels: readonly RegExp[];
  nearbyLabels: readonly RegExp[];
}

/** Spellings of the wanted cities (and of places near them) from preferences.yaml and pipeline.yaml's city tables. */
function buildLocationMatcher(preferences: PriorityInputs["preferences"], filter: PriorityInputs["pipeline"]["filter"], homeCountry: string): LocationMatcher {
  const canonicalOf = new Map<string, string>();
  const spellingsOf = new Map<string, string[]>();
  for (const [canonical, aliases] of Object.entries(filter.city_aliases)) {
    const names = [canonical, ...aliases];
    spellingsOf.set(canonical, names);
    for (const name of names) canonicalOf.set(foldText(name), canonical);
  }
  const spellings = (name: string): string[] => spellingsOf.get(canonicalOf.get(foldText(name)) ?? "") ?? [name];

  const exact = new Set<string>();
  const nearby = new Set<string>();
  for (const location of preferences.locations) {
    for (const name of spellings(location)) exact.add(foldText(name));
    const canonical = canonicalOf.get(foldText(location)) ?? location;
    for (const [city, near] of Object.entries(filter.metro_areas)) {
      if ((canonicalOf.get(foldText(city)) ?? city) !== canonical) continue;
      for (const place of near) for (const name of spellings(place)) nearby.add(foldText(name));
    }
  }
  for (const name of exact) nearby.delete(name);
  return {
    homeCountry,
    exact,
    nearby,
    exactLabels: [...exact].map((name) => wholeWordPattern(name)),
    nearbyLabels: [...nearby].map((name) => wholeWordPattern(name)),
  };
}

/** Like the hard filter: the city or the label names the place as a word ("Greater Munich Metropolitan Area", "Berlin area"). */
function placeMatches(location: JobLocation, names: ReadonlySet<string>, labels: readonly RegExp[], homeCountry: string): boolean {
  if (location.countryCode !== null && location.countryCode !== homeCountry) return false;
  const city = location.city !== null ? foldText(location.city) : "";
  if (city !== "" && (names.has(city) || names.has(city.split(",", 1)[0]?.trim() ?? city))) return true;
  return [city, foldText(location.label)].some((text) => text !== "" && labels.some((p) => p.test(text)));
}

function locationScore(job: PriorityJob, matcher: LocationMatcher, config: PriorityConfig): number {
  const fit = config.location_fit;
  if (job.locations.some((l) => placeMatches(l, matcher.exact, matcher.exactLabels, matcher.homeCountry))) return fit.exact;
  if (job.locations.some((l) => placeMatches(l, matcher.nearby, matcher.nearbyLabels, matcher.homeCountry))) return fit.nearby;
  if (job.locationUnclear) return fit.unclear;
  // in scope: remote in the home country / region, or a posting that names only the country
  if (job.workplace === "remote") return fit.remote;
  if (job.countryLevel) return fit.country_level;
  return fit.other;
}

/** Where each level sits on a ladder; the wanted level in preferences.yaml is a rung of the same ladder. */
const SENIORITY_RANK: Record<string, number> = { intern: 0, junior: 1, mid: 2, senior: 3, staff: 4, lead: 4, manager: 4, principal: 5 };
const WANTED_RANK: Record<string, number> = { entry: 1, mid: 2, senior: 3, lead: 4 };

/**
 * With `seniority_from_preferences` the fit follows the wanted level of preferences.yaml (so a junior search
 * does not rank senior postings first): `all` fits everything, otherwise the fit falls with the distance on the ladder.
 * Without a wanted level in the inputs, or with the switch off, the `seniority_fit` table of ai.yaml is used.
 */
function seniorityScore(seniority: string, config: PriorityConfig, wanted: string | undefined): number {
  const table: Record<string, number> = config.seniority_fit;
  if (!config.seniority_from_preferences || wanted === undefined) return table[seniority] ?? config.seniority_fit.unknown;
  if (wanted === "all") return 1;
  const target = WANTED_RANK[wanted];
  const rank = SENIORITY_RANK[seniority];
  if (target === undefined || rank === undefined) return config.seniority_fit.unknown;
  const steps = config.seniority_distance_fit;
  return steps[Math.min(Math.abs(rank - target), steps.length - 1)] ?? 0;
}

/** 0..1: how much of the German deduction table the posting would cost (the largest deduction is 1). */
function languageGapScore(level: GermanLevel, inputs: PriorityInputs): number {
  const penalty = languagePenalty(level, inputs.me, inputs.languagePenalty, inputs.pipeline.market.language?.code ?? null);
  const largest = Math.max(0, ...Object.values(inputs.languagePenalty));
  return largest === 0 ? 0 : clamp01(penalty / largest);
}

export type PriorityScorer = (job: PriorityJob) => PriorityBreakdown;

/** Prepare the pre-score for many jobs (terms and city spellings are built once). */
export function createPriorityScorer(inputs: PriorityInputs): PriorityScorer {
  const config = inputs.priority;
  const terms: Term[] = [
    ...inputs.preferences.target_titles.map((t) => ({ words: words(t), factor: 1 })),
    ...inputs.keywordGroupTerms.map((t) => ({ words: words(t), factor: config.keyword_group_factor })),
  ];
  const generic = new Set(config.generic_title_words.map((w) => foldText(w)));
  const matcher = buildLocationMatcher(inputs.preferences, inputs.pipeline.filter, inputs.pipeline.market.country);
  const { weights } = config;
  const nowMs = inputs.now.getTime();

  return (job) => {
    const title = titleScore(job.title, terms, generic, config);
    const signals = inputs.bonusCap > 0 ? clamp01(job.signalBonus / inputs.bonusCap) : 0;
    const location = locationScore(job, matcher, config);
    const seniority = seniorityScore(job.seniority, config, inputs.preferences.seniority);
    const ageDays = Math.max(0, (nowMs - (job.postedAt ?? job.firstSeenAt).getTime()) / DAY_MS);
    const recency = clamp01(1 - ageDays / config.recency_days);
    const languageGap = languageGapScore(job.germanLevel, inputs);
    const sum =
      weights.title * title +
      weights.signals * signals +
      weights.location * location +
      weights.seniority * seniority +
      weights.recency * recency -
      weights.language_gap * languageGap;
    const priority = job.locationUnclear && location === config.location_fit.unclear ? sum * config.unclear_location_factor : sum;
    return { title, signals, location, seniority, recency, languageGap, priority: Math.round(priority * 100) / 100 };
  };
}

/**
 * Order waiting postings for scoring: highest priority first; equal priority newest first (the order
 * before the queue order existed), then by id. Returns a new array, each item with its breakdown.
 */
export function orderByPriority<T extends { jobId: number; firstSeenAt: Date }>(
  items: readonly T[],
  breakdownOf: (item: T) => PriorityBreakdown,
): Array<T & { breakdown: PriorityBreakdown }> {
  return items
    .map((item) => ({ ...item, breakdown: breakdownOf(item) }))
    .sort(
      (a, b) =>
        b.breakdown.priority - a.breakdown.priority ||
        b.firstSeenAt.getTime() - a.firstSeenAt.getTime() ||
        b.jobId - a.jobId,
    );
}
