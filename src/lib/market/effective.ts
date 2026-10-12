/**
 * The effective pipeline config = pipeline.yaml + the generic pack + the market's pack. Lists are united (the
 * user's entries first, then the generic pack's, then the market pack's; duplicates dropped), maps are merged with
 * the user's keys winning, and the ordered local-language block comes from the pack whole. `loadPipeline()` is the
 * one entry point for code; `loadConfig("pipeline")` is only for editing the file.
 */
import { loadConfig } from "@/lib/config/load";
import type { PipelineConfig, PipelineFileConfig } from "@/lib/config/schemas/pipeline";

import { GENERIC_PACK_ID, loadPack, type Pack } from "./load";
import { loadMarket } from "./resolve";
import type { GhostPack, VisaPack, VisaPatternEntry } from "./schema";
import type { Market } from "./types";

const union = (...lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())];

function mergeMaps(user: Readonly<Record<string, readonly string[]>>, ...packs: ReadonlyArray<Readonly<Record<string, readonly string[]>>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const map of [...packs].reverse()) for (const [key, value] of Object.entries(map)) out[key] = [...value];
  for (const [key, value] of Object.entries(user)) out[key] = [...value];
  return out;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Visa pattern lists united: a pattern that is in several packs counts once (the first spelling, with or without `combo`, wins). */
function unionPatterns(...lists: ReadonlyArray<readonly VisaPatternEntry[]>): VisaPatternEntry[] {
  const seen = new Set<string>();
  const out: VisaPatternEntry[] = [];
  for (const entry of lists.flat()) {
    const key = typeof entry === "string" ? entry : entry.pattern;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** The `visa` sections of the packs, united (generic first, then the market's). */
export function mergeVisaPacks(packs: ReadonlyArray<{ rules: { visa: VisaPack } }>): VisaPack {
  const visa = packs.map((p) => p.rules.visa);
  return {
    offered: unionPatterns(...visa.map((v) => v.offered)),
    not_offered: {
      no_sponsorship: unionPatterns(...visa.map((v) => v.not_offered.no_sponsorship)),
      permit_required: unionPatterns(...visa.map((v) => v.not_offered.permit_required)),
    },
    permit_alternatives: union(...visa.map((v) => v.permit_alternatives)),
    mention_terms: unionPatterns(...visa.map((v) => v.mention_terms)),
    mention_context: union(...visa.map((v) => v.mention_context)),
    negation_cues: union(...visa.map((v) => v.negation_cues)),
    clause_breaks: union(...visa.map((v) => v.clause_breaks)),
    exclude_context: union(...visa.map((v) => v.exclude_context)),
    exclude_companies: union(...visa.map((v) => v.exclude_companies)),
    abbreviations: union(...visa.map((v) => v.abbreviations)),
    prefilter: union(...visa.map((v) => v.prefilter)),
  };
}

/** Ghost pattern lists united: a pattern in several packs counts once (the first pack's entry wins); ids may repeat across packs. */
function unionEntries<T extends { id: string; pattern: string }>(...lists: ReadonlyArray<readonly T[]>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of lists.flat()) {
    if (seen.has(entry.pattern)) continue;
    seen.add(entry.pattern);
    out.push({ ...entry });
  }
  return out;
}

/** The `ghost` sections of the packs, united (generic first, then the market's). */
export function mergeGhostPacks(packs: ReadonlyArray<{ rules: { ghost: GhostPack } }>): GhostPack {
  const ghost = packs.map((p) => p.rules.ghost);
  return {
    repost_label_patterns: unionEntries(...ghost.map((g) => g.repost_label_patterns)),
    // each entry keeps its own pack's negation window
    evergreen_patterns: unionEntries(...ghost.map((g) => g.evergreen_patterns.map((entry) => ({ ...entry, negation_after: entry.negation_after ?? g.negation_after })))),
    responsibility_patterns: unionEntries(...ghost.map((g) => g.responsibility_patterns)),
    negation_cues: union(...ghost.map((g) => g.negation_cues)),
    question_words: union(...ghost.map((g) => g.question_words)),
    negation_after: "words",
    clause_breaks: union(...ghost.map((g) => g.clause_breaks)),
    exclude_context: union(...ghost.map((g) => g.exclude_context)),
    exclude_clause: union(...ghost.map((g) => g.exclude_clause)),
    exclude_clause_ends: union(...ghost.map((g) => g.exclude_clause_ends)),
    lead_in_question: {
      ends: union(...ghost.map((g) => g.lead_in_question.ends)),
      starts: union(...ghost.map((g) => g.lead_in_question.starts)),
      line_above: ghost.some((g) => g.lead_in_question.line_above),
    },
    question_tag: {
      breaks: union(...ghost.map((g) => g.question_tag.breaks)),
      invitations: union(...ghost.map((g) => g.question_tag.invitations)),
      openers: union(...ghost.map((g) => g.question_tag.openers)),
      markers: union(...ghost.map((g) => g.question_tag.markers)),
      subjects: union(...ghost.map((g) => g.question_tag.subjects)),
    },
    abbreviations: union(...ghost.map((g) => g.abbreviations)),
    prefilter: union(...ghost.map((g) => g.prefilter)),
  };
}

/** The packs a market was built from (generic first). */
function marketPacks(market: Market, loader: (id: string) => Pack): Pack[] {
  const generic = loader(GENERIC_PACK_ID);
  return market.packId === GENERIC_PACK_ID ? [generic] : [generic, loader(market.packId)];
}

/**
 * The market with the user's pre-market-pack additions folded in (`filter.eu_countries`, `filter.remote.eu_wide_patterns`,
 * `filter.remote.outside_state_codes` of an old pipeline.yaml add to the region `eu` and the US state codes).
 */
function withUserGeography(market: Market, file: PipelineFileConfig): Market {
  const euCountries = file.filter.eu_countries;
  const euPatterns = file.filter.remote.eu_wide_patterns;
  const stateCodes = file.filter.remote.outside_state_codes;
  if (euCountries.length === 0 && euPatterns.length === 0 && stateCodes.length === 0) return market;
  const eu = market.regions.eu;
  return {
    ...market,
    regions: eu === undefined ? market.regions : { ...market.regions, eu: { ...eu, countries: union(eu.countries, euCountries), patterns: union(eu.patterns, euPatterns) } },
    subdivisionCodes: stateCodes.length === 0 ? market.subdivisionCodes : { ...market.subdivisionCodes, US: union(market.subdivisionCodes.US ?? [], stateCodes) },
  };
}

/** Build the effective config (no cache). */
export function buildEffectivePipeline(file: PipelineFileConfig, market: Market, loader: (id: string) => Pack = loadPack): PipelineConfig {
  const packs = marketPacks(market, loader);
  const rules = packs.map((p) => p.rules);
  const geo = packs.map((p) => p.geography);
  const pick = <T>(get: (r: Pack["rules"]) => readonly T[]): T[][] => rules.map((r) => [...get(r)]);
  const listOf = (user: readonly string[], get: (r: Pack["rules"]) => readonly string[]): string[] => union(user, ...pick(get));
  const stopwords: Record<string, string[]> = {};
  for (const pack of packs) for (const [code, words] of Object.entries(pack.language.stopwords)) stopwords[code] = union(stopwords[code] ?? [], words);

  const { eu_countries: _euCountries, remote: fileRemote, ...fileFilter } = file.filter;
  void _euCountries;
  const { eu_wide_patterns: _euWide, outside_state_codes: _states, ...remote } = fileRemote;
  void _euWide;
  void _states;

  return deepFreeze({
    ...file,
    company: {
      legal_suffixes: listOf(file.company.legal_suffixes, (r) => r.company.legal_suffixes),
      aliases: file.company.aliases,
      agency_names: listOf(file.company.agency_names, (r) => r.company.agency_names),
    },
    agency: {
      ...file.agency,
      company_name_patterns: listOf(file.agency.company_name_patterns, (r) => r.agency.company_name_patterns),
      text_patterns: listOf(file.agency.text_patterns, (r) => r.agency.text_patterns),
      exclude_context_patterns: listOf(file.agency.exclude_context_patterns, (r) => r.agency.exclude_context_patterns),
    },
    contract: {
      student: listOf(file.contract.student, (r) => r.contract.student),
      temp_agency: listOf(file.contract.temp_agency, (r) => r.contract.temp_agency),
      direct_hire: listOf(file.contract.direct_hire, (r) => r.contract.direct_hire),
      freelance: listOf(file.contract.freelance, (r) => r.contract.freelance),
      fixed_term: listOf(file.contract.fixed_term, (r) => r.contract.fixed_term),
      permanent: listOf(file.contract.permanent, (r) => r.contract.permanent),
    },
    salary: {
      ...file.salary,
      local_currencies: file.salary.local_currencies ?? [market.currency],
      currencies: mergeCurrencies(packs),
    },
    language: {
      min_words_for_detection: file.language.min_words_for_detection,
      stopwords,
      requirement: market.language === null ? null : (file.language.requirement ?? market.language.requirement),
    },
    filter: {
      ...fileFilter,
      city_aliases: mergeMaps(file.filter.city_aliases, ...geo.map((g) => g.city_aliases)),
      metro_areas: mergeMaps(file.filter.metro_areas, ...geo.map((g) => g.metro_areas)),
      metro_regions: mergeMaps(file.filter.metro_regions, ...geo.map((g) => g.metro_regions)),
      country_level: { ...file.filter.country_level, patterns: union(file.filter.country_level.patterns, ...geo.map((g) => g.country_level_patterns)) },
      generic_location_patterns: listOf(file.filter.generic_location_patterns, (r) => r.filter.generic_location_patterns),
      remote: {
        ...remote,
        worldwide_patterns: listOf(remote.worldwide_patterns, (r) => r.filter.remote.worldwide_patterns),
        outside_patterns: listOf(remote.outside_patterns, (r) => r.filter.remote.outside_patterns),
        title_outside_patterns: listOf(remote.title_outside_patterns, (r) => r.filter.remote.title_outside_patterns),
        description_in_scope_patterns: listOf(remote.description_in_scope_patterns, (r) => r.filter.remote.description_in_scope_patterns),
      },
    },
    market: withUserGeography(market, file),
    closed_posting: { phrases: union(...pick((r) => r.closed_posting.phrases)) },
    ghost: mergeGhostPacks(packs),
    visa: mergeVisaPacks(packs),
  });
}

/** The currency tokens of the packs, one entry per code (a later pack adds tokens to an earlier pack's entry). */
function mergeCurrencies(packs: readonly Pack[]): PipelineConfig["salary"]["currencies"] {
  const byCode = new Map<string, { code: string; symbols: string[]; words: string[] }>();
  for (const pack of packs) {
    for (const entry of pack.rules.salary.currencies) {
      const current = byCode.get(entry.code) ?? { code: entry.code, symbols: [], words: [] };
      byCode.set(entry.code, { code: entry.code, symbols: union(current.symbols, entry.symbols), words: union(current.words, entry.words) });
    }
  }
  return [...byCode.values()];
}

const cache = new WeakMap<PipelineFileConfig, WeakMap<Market, PipelineConfig>>();

/** The effective config of this file under this market, cached per pair (a hot reload of either yields new objects). */
export function effectivePipeline(file: PipelineFileConfig, market: Market, loader: (id: string) => Pack = loadPack): PipelineConfig {
  let byMarket = cache.get(file);
  if (!byMarket) {
    byMarket = new WeakMap();
    cache.set(file, byMarket);
  }
  const hit = byMarket.get(market);
  if (hit) return hit;
  const built = buildEffectivePipeline(file, market, loader);
  byMarket.set(market, built);
  return built;
}

/**
 * The pipeline config the code reads: pipeline.yaml (user file or shipped default) with the packs of the current
 * market. Throws MarketUnresolvedError when the market cannot be resolved (the caller skips its step, see resolve.ts).
 */
export function loadPipeline(): PipelineConfig {
  return effectivePipeline(loadConfig("pipeline"), loadMarket());
}
