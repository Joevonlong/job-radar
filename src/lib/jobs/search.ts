/** Server entry: configuration loaders use Node APIs; the pure parser lives in search-query.ts. */
import { loadConfig, type JobSearchConfig, type PipelineConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";

import { buildCountryLexicon, parseSearchQuery, type CountryLexicon, type SearchPlan } from "./search-query";

const lexicons = new WeakMap<JobSearchConfig, WeakMap<PipelineConfig, CountryLexicon>>();

/** Loaded relevance, matching and palette settings for server callers. */
export function jobSearchSettings(): JobSearchConfig {
  return loadConfig("jobSearch");
}

/** Build a query plan with the current market; new config identities invalidate the country lexicon. */
export function buildSearchPlan(q: string | null | undefined): SearchPlan {
  const settings = jobSearchSettings();
  const pipeline = loadPipeline();
  let byPipeline = lexicons.get(settings);
  if (!byPipeline) {
    byPipeline = new WeakMap();
    lexicons.set(settings, byPipeline);
  }
  let lexicon = byPipeline.get(pipeline);
  if (!lexicon) {
    lexicon = buildCountryLexicon(pipeline.market.countries, {
      locales: settings.countries.name_locales,
      ambiguousCodes: settings.countries.ambiguous_codes,
      extraAliases: settings.countries.extra_aliases,
    });
    byPipeline.set(pipeline, lexicon);
  }
  return parseSearchQuery(q, {
    lexicon,
    cityAliases: pipeline.filter.city_aliases,
    transliterations: pipeline.market.transliterations,
    settings: {
      ranking: { weights: settings.ranking.weights, prefixFactor: settings.ranking.prefix_factor },
      maxChars: settings.query.max_chars,
      maxTerms: settings.query.max_terms,
      cjkMinChars: settings.query.cjk_min_chars,
      prefixMinChars: settings.matching.prefix_min_chars,
    },
  });
}
