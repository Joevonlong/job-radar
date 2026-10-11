/**
 * The files of a market pack (`config/packs/<id>/`, user copy in `data/config/packs/<id>/`) and the market
 * settings of preferences.yaml, validated with zod (C6). A pack is public data: countries, regions, cities, rule
 * phrases. Every section is optional; which sections a pack has is a matter of its data.
 */
import { z } from "zod";

import { nonEmptyString, phraseRegexString, positiveInt, regexString, remoteScope } from "@/lib/config/schemas/common";

export const PACK_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const packId = z.string().regex(PACK_ID_PATTERN, "must be a pack id (lower case letters, digits, - or _)");
export const countryCode = z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code (upper case)");
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code (upper case)");
export const languageCode = z.string().regex(/^[a-z]{2,3}$/, "must be an ISO 639 code (lower case)");
export const regionId = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, "must be a region id (lower case)");

const regexList = z.array(regexString);
const stringList = z.array(nonEmptyString);
const cefr = z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]);

/** `pack.yaml`: what the pack is and the market defaults it gives (each one optional: a generic pack names none). */
export const packMetaSchema = z.strictObject({
  id: packId,
  /** English display name ("Germany"). */
  name: nonEmptyString,
  country: countryCode.optional(),
  currency: currencyCode.optional(),
  /** The local language of the market; its requirement rules are in language.yaml. */
  language: languageCode.optional(),
  /** BCP 47 locale for upper / lower case of place names ("de-DE"). */
  locale: nonEmptyString.optional(),
  /** The named region (geography `regions`) the country belongs to: what "remote within the home region" means. */
  region: regionId.optional(),
  /** Channels that only make sense in this market, for "enable local sources": ids of sources.yaml. */
  default_channels: z.array(nonEmptyString).default([]),
});
export type PackMeta = z.infer<typeof packMetaSchema>;

export const countryEntrySchema = z.strictObject({
  code: countryCode,
  /** English name; the default rule matches it and the aliases as whole words. */
  name: nonEmptyString,
  /** The country's currency: what the setup wizard proposes as the base currency when the country is picked. */
  currency: currencyCode.optional(),
  aliases: stringList.default([]),
  /** The country name python-jobspy's Indeed scraper knows ("germany", "usa"); absent = Indeed does not serve it. */
  indeed: nonEmptyString.optional(),
  /** An explicit rule instead of the name (case-insensitive regular expression). */
  pattern: regexString.optional(),
  /** false: the country is never read from a text (its name is a common word or a US state: Georgia, Jersey). */
  match: z.boolean().default(true),
});
export type CountryEntry = z.infer<typeof countryEntrySchema>;

export const regionSchema = z.strictObject({
  name: nonEmptyString,
  countries: z.array(countryCode).min(1),
  /** Location texts that name the region as a whole ("EU", "Europe", "EMEA"). */
  patterns: regexList.default([]),
});
export type RegionData = z.infer<typeof regionSchema>;

/** `geography.yaml`. */
export const packGeographySchema = z.strictObject({
  /**
   * Phase switch: false reproduces the old behaviour (a location that names a country outside the city
   * table has no country at all); true gives it that country's code.
   */
  resolve_world_countries: z.boolean().optional(),
  /** Country table, in the order the rules are tried (first match wins). */
  countries: z.array(countryEntrySchema).default([]),
  regions: z.record(regionId, regionSchema).default({}),
  /** Spelling in a location (lower case) -> [canonical city name, country]. The canonical name is part of the dedupe key. */
  cities: z.record(nonEmptyString, z.tuple([nonEmptyString, countryCode])).default({}),
  /** Country -> codes of its states that follow a place after a comma, a dash or a slash ("Austin, TX"). Case-sensitive. */
  subdivision_codes: z.record(countryCode, z.array(z.string().regex(/^[A-Z]{2,3}$/, "must be an upper-case code"))).default({}),
  /** Words that start a location text which is not a city ("remote", "multiple"): no city is read from it (regular expression fragments). */
  non_city_labels: z.array(nonEmptyString).default([]),
  /** A city candidate containing one of these is not a city ("home office"). */
  non_city_words: regexList.default([]),
  /** Canonical city name -> other spellings (merged with pipeline.yaml `filter.city_aliases`). */
  city_aliases: z.record(nonEmptyString, stringList).default({}),
  /** City -> towns that count as the city (pipeline.yaml `filter.metro_areas`). */
  metro_areas: z.record(nonEmptyString, stringList).default({}),
  /** City -> regions that contain it but are too coarse to say (pipeline.yaml `filter.metro_regions`). */
  metro_regions: z.record(nonEmptyString, stringList).default({}),
  /** Location texts that name only the home country ("Germany", "bundesweit"); the whole text must match. */
  country_level_patterns: regexList.default([]),
  /** Letter -> spelling without it, for sources that avoid the letter ("ü" -> "ue"). */
  transliterations: z.record(z.string().length(1), z.string()).default({}),
});
export type PackGeography = z.infer<typeof packGeographySchema>;

/** The rules that read the local-language requirement of a posting (was pipeline.yaml `language.german_*`). */
export const languageRequirementSchema = z.strictObject({
  /** A mention of the language ("German", "Deutsch…"), matched globally. */
  word_pattern: regexString,
  /** The language name next to a CEFR level ("German C1", "Deutschkenntnisse B2", "B2 German"). */
  cefr_name_pattern: regexString,
  /** Words allowed between the name and a level after it ("at", "level", "niveau", "auf" …), regular expression fragments. */
  cefr_connectors: z.array(nonEmptyString).min(1),
  /** "B2-level German", "B2 Niveau Deutsch". */
  cefr_level_words: z.array(nonEmptyString).default([]),
  /** "B2 in German", "C1 of German". */
  cefr_prepositions: z.array(nonEmptyString).default([]),
  /** A level phrase only counts within this many characters of the language word. */
  level_max_distance: positiveInt,
  /** Phrases that name a level; the one closest to the language word wins, ties go to the earlier rule. */
  level_rules: z.array(z.strictObject({ pattern: regexString, level: cefr })),
  optional_max_distance: positiveInt,
  /** Markers that make the language "nice to have" (level `preferred`). */
  optional_patterns: regexList,
  /** Language names (lower case) that may follow it in a list ("German, Spanish or French are a plus"). */
  list_languages: z.array(nonEmptyString),
  /** Text that contains the language word without talking about the language ("German citizen"). */
  ignore_patterns: regexList,
  preferred_section_patterns: regexList,
  required_section_patterns: regexList,
  required_patterns: regexList,
  section_max_distance: positiveInt,
  /** "No German required": level `none`. */
  not_required_patterns: regexList,
  /** "C1 is a plus, B2 is sufficient": the level that is enough. */
  sufficient_patterns: regexList,
  /** Typical wording -> level, for the scoring prompt ("fluent / native = C1; good German = B2 …"). */
  prompt_examples: nonEmptyString,
});
export type LanguageRequirement = z.infer<typeof languageRequirementSchema>;

/** `language.yaml`. */
export const packLanguageSchema = z.strictObject({
  /** Language code -> stopwords, for telling the language of a description. */
  stopwords: z.record(languageCode, z.array(nonEmptyString)).default({}),
  /** Requirement rules for the pack's language (`pack.yaml` `language`). */
  requirement: languageRequirementSchema.optional(),
});
export type PackLanguage = z.infer<typeof packLanguageSchema>;

const optionalList = regexList.default([]);

/** `rules.yaml`: pieces of pipeline.yaml that are language / market specific. Lists are united with the user's and the other packs'. */
export const packRulesSchema = z.strictObject({
  company: z.strictObject({ legal_suffixes: stringList.default([]), agency_names: stringList.default([]) }).default({ legal_suffixes: [], agency_names: [] }),
  agency: z
    .strictObject({ company_name_patterns: optionalList, text_patterns: optionalList, exclude_context_patterns: optionalList })
    .default({ company_name_patterns: [], text_patterns: [], exclude_context_patterns: [] }),
  contract: z
    .strictObject({ student: optionalList, temp_agency: optionalList, direct_hire: optionalList, freelance: optionalList, fixed_term: optionalList, permanent: optionalList })
    .default({ student: [], temp_agency: [], direct_hire: [], freelance: [], fixed_term: [], permanent: [] }),
  /** How currencies are written in salary texts (symbols as they are, words not followed by a letter). */
  salary: z
    .strictObject({
      currencies: z
        .array(z.strictObject({ code: currencyCode, symbols: z.array(regexString).default([]), words: z.array(regexString).default([]) }))
        .default([]),
    })
    .default({ currencies: [] }),
  filter: z
    .strictObject({
      generic_location_patterns: optionalList,
      remote: z
        .strictObject({ worldwide_patterns: optionalList, outside_patterns: optionalList, title_outside_patterns: optionalList, description_in_scope_patterns: optionalList })
        .default({ worldwide_patterns: [], outside_patterns: [], title_outside_patterns: [], description_in_scope_patterns: [] }),
    })
    .default({ generic_location_patterns: [], remote: { worldwide_patterns: [], outside_patterns: [], title_outside_patterns: [], description_in_scope_patterns: [] } }),
  /** Phrases (regex) in a posting page's visible text that say it no longer takes applications (the watched-job recheck). */
  // Run on untrusted pages, so only the safe pattern subset (see unsafePhraseReason)
  closed_posting: z.strictObject({ phrases: z.array(phraseRegexString).default([]) }).default({ phrases: [] }),
});
export type PackRules = z.infer<typeof packRulesSchema>;

/** The pack files, the file name each lives in and its schema. Only `pack.yaml` is required. */
export const PACK_FILES = {
  meta: { file: "pack.yaml", schema: packMetaSchema, required: true },
  geography: { file: "geography.yaml", schema: packGeographySchema, required: false },
  language: { file: "language.yaml", schema: packLanguageSchema, required: false },
  rules: { file: "rules.yaml", schema: packRulesSchema, required: false },
} as const;
export type PackPart = keyof typeof PACK_FILES;

/** preferences.yaml `market`: which pack, and the market values when they differ from the pack's. */
export const marketSettingsSchema = z.strictObject({
  pack: packId,
  /** Home country; default the pack's. */
  country: countryCode.optional(),
  /** Base currency (salary floor, statistics, T1 threshold); default the pack's. */
  currency: currencyCode.optional(),
  /** The local language whose requirement is read and costs points; default the pack's. */
  home_language: languageCode.optional(),
});
export type MarketSettings = z.infer<typeof marketSettingsSchema>;

export { regionToken } from "@/lib/config/schemas/common";
export const remoteScopeSchema = remoteScope;
export type RemoteScopeValue = z.infer<typeof remoteScopeSchema>;
