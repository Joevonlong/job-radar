import type { CountryEntry, LanguageRequirement, RegionData } from "./schema";

/**
 * The resolved market (preferences.yaml `market` + the generic pack + the market's pack). Plain, frozen data;
 * everything market-specific the pipeline, the filter and the pages need is read from here, never from code literals.
 */
export interface Market {
  packId: string;
  /** English name of the pack ("Germany", "Generic"). */
  packName: string;
  /** Home country (ISO 3166-1 alpha-2). */
  country: string;
  /** English name of the home country (country table). */
  countryName: string;
  /** Base currency (ISO 4217). */
  currency: string;
  /** Local language (ISO 639-1). */
  homeLanguage: string;
  /** BCP 47 locale for case rules of place names. */
  locale: string;
  /** The named region the home country belongs to (what "remote in the home region" means), or null. */
  homeRegion: string | null;
  /** Country table: generic first, then the pack's (first match wins). */
  countries: readonly CountryEntry[];
  regions: Readonly<Record<string, RegionData>>;
  /** Spelling (lower case) -> [canonical city, country]. */
  cities: Readonly<Record<string, readonly [string, string]>>;
  subdivisionCodes: Readonly<Record<string, readonly string[]>>;
  nonCityLabels: readonly string[];
  nonCityWords: readonly string[];
  transliterations: Readonly<Record<string, string>>;
  /** Phase switch: a location naming a country outside the city table gets that country (true) or none (false). */
  resolveWorldCountries: boolean;
  /** The local-language step: on when the pack has rules for `homeLanguage`. */
  language: { code: string; requirement: LanguageRequirement } | null;
  /** Channels of the pack's `default_channels`. */
  defaultChannels: readonly string[];
}
