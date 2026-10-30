/** Server entry: configuration loaders use Node APIs; the pure parser lives in search-query.ts. */
import { loadConfig, type JobSearchConfig, type PipelineConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";

import { buildCountryLexicon, parseSearchQuery, type CountryLexicon, type SearchPlan } from "./search-query";

const lexicons = new WeakMap<JobSearchConfig, WeakMap<PipelineConfig, CountryLexicon>>();

/** Loaded relevance, matching and palette settings for server callers. */
export function jobSearchSettings(): JobSearchConfig {
  return loadConfig("jobSearch");
}

function lexiconOptions(settings: JobSearchConfig) {
  return { locales: settings.countries.name_locales, ambiguousCodes: settings.countries.ambiguous_codes, extraAliases: settings.countries.extra_aliases };
}

function countryLexicon(settings: JobSearchConfig, pipeline: PipelineConfig): CountryLexicon {
  let byPipeline = lexicons.get(settings);
  if (!byPipeline) {
    byPipeline = new WeakMap();
    lexicons.set(settings, byPipeline);
  }
  let lexicon = byPipeline.get(pipeline);
  if (!lexicon) {
    lexicon = buildCountryLexicon(pipeline.market.countries, lexiconOptions(settings));
    byPipeline.set(pipeline, lexicon);
  }
  return lexicon;
}

/** A null pipeline parses without market vocabulary: no country names or codes, no city aliases or transliterations. */
function planWith(q: string, settings: JobSearchConfig, pipeline: PipelineConfig | null): SearchPlan {
  return parseSearchQuery(q, {
    lexicon: pipeline ? countryLexicon(settings, pipeline) : buildCountryLexicon([], lexiconOptions(settings)),
    cityAliases: pipeline?.filter.city_aliases ?? {},
    transliterations: pipeline?.market.transliterations ?? {},
    settings: {
      ranking: { weights: settings.ranking.weights, prefixFactor: settings.ranking.prefix_factor },
      maxChars: settings.query.max_chars,
      maxTerms: settings.query.max_terms,
      cjkMinChars: settings.query.cjk_min_chars,
      prefixMinChars: settings.matching.prefix_min_chars,
      allScopeTimeoutMs: settings.query.all_scope_timeout_ms,
    },
  });
}

/** Build a query plan with the current market; new config identities invalidate the country lexicon. */
export function buildSearchPlan(q: string): SearchPlan {
  return planWith(q, jobSearchSettings(), loadPipeline());
}

/**
 * For the MCP server: a pipeline.yaml that fails to load must not take search down with it. The query still matches as
 * text, only without the market's country names and city spellings.
 */
export function buildSearchPlanLenient(q: string): SearchPlan {
  const settings = jobSearchSettings();
  let pipeline: PipelineConfig | null;
  try {
    pipeline = loadPipeline();
  } catch {
    pipeline = null;
  }
  return planWith(q, settings, pipeline);
}
